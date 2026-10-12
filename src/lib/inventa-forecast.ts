// INVENTA drug-order forecast, stage 1 — sales-based (CLINICA bill lines →
// consumption rate → days of cover → suggested order / dead stock).
//
// Pure read-only over clinica_bill_items + inventa_items; no schema change.
// An INVENTA item is matched to bill lines by item_code == bill code (exact,
// trimmed), falling back to an exact case-insensitive name match. Quantities
// are compared as-is: the bill's sale unit is assumed to be the stock unit
// (the page flags that assumption to the user).
import { getDb } from "./db";

export const FORECAST_WINDOW_DAYS = 90;
export const FORECAST_LEAD_DAYS = 7;       // supplier lead time
export const FORECAST_BUFFER_DAYS = 14;    // extra cover wanted after the order lands
export const FORECAST_OVERSTOCK_DAYS = 90; // more cover than this = capital sitting idle
const MS_DAY = 86_400_000;

export type ForecastStatus = "reorder" | "ok" | "overstock" | "dead" | "no_sales" | "skipped";

export type ForecastRow = {
  itemId: number;
  name: string;
  code: string | null;
  unit: string | null;
  supplier: string | null;
  onHand: number;
  soldWindow: number;       // units sold in the window
  sold30: number;
  perDay: number;           // average units/day over the window
  coverDays: number | null; // onHand / perDay; null when nothing sold
  suggestedQty: number;     // units to order to reach lead + buffer cover
  tiedUpValue: number;      // cost of stock beyond FORECAST_OVERSTOCK_DAYS (dead stock = all of it)
  status: ForecastStatus;
};

export type ForecastResult = {
  asOf: string;
  windowDays: number;       // actual days of sales history used (<= FORECAST_WINDOW_DAYS)
  hasSalesData: boolean;
  rows: ForecastRow[];
  totals: { reorder: number; overstock: number; dead: number; tiedUpValue: number };
};

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** Forecast for one branch. `asOf` is an ISO day (defaults to today). */
export function inventaForecast(branchId: number, asOf: string = isoDay(Date.now())): ForecastResult {
  const db = getDb();
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  const from = isoDay(asOfMs - FORECAST_WINDOW_DAYS * MS_DAY);
  const from30 = isoDay(asOfMs - 30 * MS_DAY);

  const bounds = db.prepare(`
    SELECT MIN(bill_date) AS first FROM clinica_bills
    WHERE branch_id = ? AND bill_date <> '' AND bill_date >= ? AND bill_date <= ?
  `).get(branchId, from, asOf) as { first: string | null };
  const hasSalesData = !!bounds.first;
  // Days of history actually available — a branch with only 3 weeks of
  // imports must not be divided by 90.
  const windowDays = hasSalesData
    ? Math.max(1, Math.min(FORECAST_WINDOW_DAYS, Math.round((asOfMs - Date.parse(`${bounds.first}T00:00:00Z`)) / MS_DAY) + 1))
    : FORECAST_WINDOW_DAYS;

  // Sold qty per bill code / per lower-cased name, whole window and last 30 days.
  const sales = db.prepare(`
    SELECT TRIM(COALESCE(i.code, '')) AS code, LOWER(TRIM(COALESCE(i.name, ''))) AS name,
           SUM(i.qty) AS qty,
           SUM(CASE WHEN b.bill_date >= ? THEN i.qty ELSE 0 END) AS qty30
    FROM clinica_bill_items i JOIN clinica_bills b ON b.id = i.bill_id
    WHERE b.branch_id = ? AND b.bill_date <> '' AND b.bill_date >= ? AND b.bill_date <= ? AND i.qty > 0
    GROUP BY TRIM(COALESCE(i.code, '')), LOWER(TRIM(COALESCE(i.name, '')))
  `).all(from30, branchId, from, asOf) as Array<{ code: string; name: string; qty: number; qty30: number }>;
  const byCode = new Map<string, { qty: number; qty30: number }>();
  const byName = new Map<string, { qty: number; qty30: number }>();
  const add = (m: Map<string, { qty: number; qty30: number }>, k: string, qty: number, qty30: number) => {
    if (!k) return;
    const cur = m.get(k) ?? { qty: 0, qty30: 0 };
    cur.qty += qty; cur.qty30 += qty30; m.set(k, cur);
  };
  for (const s of sales) { add(byCode, s.code, s.qty, s.qty30); add(byName, s.name, s.qty, s.qty30); }

  const items = db.prepare(`
    SELECT i.id, i.name, i.item_code, i.unit, i.current_qty, i.count_mode,
           COALESCE(i.cost_price, i.unit_cost, 0) AS cost, s.name AS supplier
    FROM inventa_items i LEFT JOIN inventa_suppliers s ON s.id = i.supplier_id
    WHERE i.active = 1 AND i.item_type = 'drug' AND (i.branch_id IS ? OR i.branch_id = ?)
    ORDER BY i.name COLLATE NOCASE
  `).all(branchId, branchId) as Array<{
    id: number; name: string; item_code: string | null; unit: string | null; current_qty: number;
    count_mode: string | null; cost: number; supplier: string | null;
  }>;

  const target = FORECAST_LEAD_DAYS + FORECAST_BUFFER_DAYS;
  const rows: ForecastRow[] = items.map((it) => {
    const base = { itemId: it.id, name: it.name, code: it.item_code, unit: it.unit, supplier: it.supplier, onHand: it.current_qty };
    // Fractional (open-bottle) items are counted in bottles with decimals;
    // their current_qty is not a comparable unit count, so they're left out.
    if (it.count_mode === "fractional") {
      return { ...base, soldWindow: 0, sold30: 0, perDay: 0, coverDays: null, suggestedQty: 0, tiedUpValue: 0, status: "skipped" as const };
    }
    const hit = (it.item_code && byCode.get(it.item_code.trim())) || byName.get(norm(it.name)) || null;
    const soldWindow = hit?.qty ?? 0;
    const sold30 = hit?.qty30 ?? 0;
    const perDay = hasSalesData ? soldWindow / windowDays : 0;
    const coverDays = perDay > 0 ? it.current_qty / perDay : null;
    const suggestedQty = perDay > 0 ? Math.max(0, Math.ceil(perDay * target - it.current_qty)) : 0;

    let status: ForecastStatus;
    let tiedUpValue = 0;
    if (!hasSalesData) status = "no_sales";
    else if (perDay === 0) {
      status = it.current_qty > 0 ? "dead" : "no_sales";
      if (status === "dead") tiedUpValue = it.current_qty * it.cost;
    } else if (coverDays! < FORECAST_LEAD_DAYS) status = "reorder";
    else if (coverDays! > FORECAST_OVERSTOCK_DAYS) {
      status = "overstock";
      tiedUpValue = Math.max(0, it.current_qty - perDay * FORECAST_OVERSTOCK_DAYS) * it.cost;
    } else status = "ok";
    return { ...base, soldWindow, sold30, perDay, coverDays, suggestedQty, tiedUpValue, status };
  });

  const count = (s: ForecastStatus) => rows.filter((r) => r.status === s).length;
  return {
    asOf, windowDays, hasSalesData, rows,
    totals: { reorder: count("reorder"), overstock: count("overstock"), dead: count("dead"), tiedUpValue: rows.reduce((a, r) => a + r.tiedUpValue, 0) }
  };
}
