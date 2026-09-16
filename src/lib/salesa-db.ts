// SALESA — data-access layer for daily POS sales analytics (owner 2026-09-16).
// Schema lives in db.ts (salesa_daily / salesa_menu / salesa_weekly_sent /
// salesa_settings). This module upserts imported files, reads the dashboard
// views, and stores the HOD LINE-group binding.

import { getDb } from "./db";
import type { SalesCloseUp, SalesOverview, PayEntry, TypeEntry, MenuEntry } from "./salesa-parse";

export type DailyRow = {
  branch_id: number;
  sale_date: string;
  merchant: string | null;
  nett: number;
  gross: number;
  gross_before_charges: number;
  discount: number;
  service_charge: number;
  vat: number;
  rounding: number;
  delivery_fee: number;
  other_charge: number;
  bill_count: number;
  pax: number;
  void_amount: number;
  void_bill_count: number;
  refund: number;
  avg_sales: number;
  avg_pax: number;
  avg_sales_pax: number;
  payments: PayEntry[];
  types: TypeEntry[];
  sources: TypeEntry[];
  has_sales: number;
  has_menu: number;
  daily_sent_at: string | null;
  imported_at: string;
};

type RawDaily = Omit<DailyRow, "payments" | "types" | "sources"> & {
  payments_json: string; types_json: string; sources_json: string;
};

function hydrate(r: RawDaily): DailyRow {
  const safe = <T>(s: string, fallback: T): T => { try { return JSON.parse(s) as T; } catch { return fallback; } };
  const { payments_json, types_json, sources_json, ...rest } = r;
  return {
    ...rest,
    payments: safe<PayEntry[]>(payments_json, []),
    types: safe<TypeEntry[]>(types_json, []),
    sources: safe<TypeEntry[]>(sources_json, [])
  };
}

/** SALESA is available on any real branch (the operator's active branch). */
export function isSalesaBranch(branchId: number): boolean {
  return !!getDb().prepare("SELECT 1 FROM branches WHERE id = ?").get(branchId);
}

// ── Imports ──────────────────────────────────────────────────────────────

/** Upsert the close_up KPIs for a (branch, date). Preserves has_menu + sent
 *  markers; flips has_sales on. */
export function upsertDaily(branchId: number, userId: number, c: SalesCloseUp): void {
  getDb().prepare(`
    INSERT INTO salesa_daily (
      branch_id, sale_date, merchant, nett, gross, gross_before_charges, discount,
      service_charge, vat, rounding, delivery_fee, other_charge, bill_count, pax,
      void_amount, void_bill_count, refund, avg_sales, avg_pax, avg_sales_pax,
      payments_json, types_json, sources_json, has_sales, imported_by, imported_at
    ) VALUES (
      @branch_id, @sale_date, @merchant, @nett, @gross, @gross_before_charges, @discount,
      @service_charge, @vat, @rounding, @delivery_fee, @other_charge, @bill_count, @pax,
      @void_amount, @void_bill_count, @refund, @avg_sales, @avg_pax, @avg_sales_pax,
      @payments_json, @types_json, @sources_json, 1, @user, datetime('now')
    )
    ON CONFLICT(branch_id, sale_date) DO UPDATE SET
      merchant = excluded.merchant, nett = excluded.nett, gross = excluded.gross,
      gross_before_charges = excluded.gross_before_charges, discount = excluded.discount,
      service_charge = excluded.service_charge, vat = excluded.vat, rounding = excluded.rounding,
      delivery_fee = excluded.delivery_fee, other_charge = excluded.other_charge,
      bill_count = excluded.bill_count, pax = excluded.pax, void_amount = excluded.void_amount,
      void_bill_count = excluded.void_bill_count, refund = excluded.refund,
      avg_sales = excluded.avg_sales, avg_pax = excluded.avg_pax, avg_sales_pax = excluded.avg_sales_pax,
      payments_json = excluded.payments_json, types_json = excluded.types_json,
      sources_json = excluded.sources_json, has_sales = 1,
      imported_by = excluded.imported_by, imported_at = datetime('now')
  `).run({
    branch_id: branchId, sale_date: c.date, merchant: c.merchant, nett: c.nett, gross: c.gross,
    gross_before_charges: c.grossBeforeCharges, discount: c.discount, service_charge: c.serviceCharge,
    vat: c.vat, rounding: c.rounding, delivery_fee: c.deliveryFee, other_charge: c.otherCharge,
    bill_count: c.billCount, pax: c.pax, void_amount: c.voidAmount, void_bill_count: c.voidBillCount,
    refund: c.refund, avg_sales: c.avgSales, avg_pax: c.avgPax, avg_sales_pax: c.avgSalesPax,
    payments_json: JSON.stringify(c.payments), types_json: JSON.stringify(c.types),
    sources_json: JSON.stringify(c.sources), user: userId
  });
}

/** Upsert the menu-revenue ranking for a (branch, date). Ensures a daily row
 *  exists (so a menu-only import still shows up), flips has_menu on, and
 *  replaces that day's menu rows. */
export function upsertMenu(branchId: number, userId: number, o: SalesOverview): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO salesa_daily (branch_id, sale_date, merchant, has_menu, imported_by, imported_at)
      VALUES (?, ?, ?, 1, ?, datetime('now'))
      ON CONFLICT(branch_id, sale_date) DO UPDATE SET
        has_menu = 1,
        merchant = COALESCE(salesa_daily.merchant, excluded.merchant),
        imported_by = excluded.imported_by
    `).run(branchId, o.date, o.merchant, userId);
    db.prepare("DELETE FROM salesa_menu WHERE branch_id = ? AND sale_date = ?").run(branchId, o.date);
    const ins = db.prepare(
      "INSERT INTO salesa_menu (branch_id, sale_date, kind, name, nett, rank) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const write = (kind: "item" | "category", list: MenuEntry[]) =>
      list.forEach((m, i) => ins.run(branchId, o.date, kind, m.name, m.nett, i + 1));
    write("item", o.items);
    write("category", o.categories);
  });
  tx();
}

// ── Reads ────────────────────────────────────────────────────────────────

export function getDaily(branchId: number, date: string): DailyRow | null {
  const r = getDb().prepare("SELECT * FROM salesa_daily WHERE branch_id = ? AND sale_date = ?")
    .get(branchId, date) as RawDaily | undefined;
  return r ? hydrate(r) : null;
}

/** Daily rows within [start, end] inclusive, ascending. */
export function listRange(branchId: number, start: string, end: string): DailyRow[] {
  return (getDb().prepare(
    "SELECT * FROM salesa_daily WHERE branch_id = ? AND sale_date BETWEEN ? AND ? ORDER BY sale_date ASC"
  ).all(branchId, start, end) as RawDaily[]).map(hydrate);
}

export function listMonth(branchId: number, year: number, month: number): DailyRow[] {
  const mm = String(month).padStart(2, "0");
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return listRange(branchId, `${year}-${mm}-01`, `${year}-${mm}-${String(last).padStart(2, "0")}`);
}

export function getMenu(branchId: number, date: string): { items: MenuEntry[]; categories: MenuEntry[] } {
  const rows = getDb().prepare(
    "SELECT kind, name, nett FROM salesa_menu WHERE branch_id = ? AND sale_date = ? ORDER BY rank ASC"
  ).all(branchId, date) as Array<{ kind: string; name: string; nett: number }>;
  return {
    items: rows.filter((r) => r.kind === "item").map((r) => ({ name: r.name, nett: r.nett })),
    categories: rows.filter((r) => r.kind === "category").map((r) => ({ name: r.name, nett: r.nett }))
  };
}

/** Menu revenue aggregated over [start, end] (for the weekly card). */
export function menuRange(branchId: number, start: string, end: string, kind: "item" | "category"): MenuEntry[] {
  const rows = getDb().prepare(
    `SELECT name, SUM(nett) AS nett FROM salesa_menu
     WHERE branch_id = ? AND kind = ? AND sale_date BETWEEN ? AND ?
     GROUP BY name ORDER BY nett DESC`
  ).all(branchId, kind, start, end) as Array<{ name: string; nett: number }>;
  return rows.map((r) => ({ name: r.name, nett: Math.round((r.nett + Number.EPSILON) * 100) / 100 }));
}

// ── Mutations ──────────────────────────────────────────────────────────────

export function clearDay(branchId: number, date: string): number {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM salesa_menu WHERE branch_id = ? AND sale_date = ?").run(branchId, date);
    return db.prepare("DELETE FROM salesa_daily WHERE branch_id = ? AND sale_date = ?").run(branchId, date).changes;
  });
  return tx() as number;
}

export function markDailySent(branchId: number, date: string, userId: number): void {
  getDb().prepare(
    "UPDATE salesa_daily SET daily_sent_at = datetime('now'), daily_sent_by = ? WHERE branch_id = ? AND sale_date = ?"
  ).run(userId, branchId, date);
}

export function markWeeklySent(branchId: number, weekStart: string, userId: number): void {
  getDb().prepare(
    `INSERT INTO salesa_weekly_sent (branch_id, week_start, sent_at, sent_by)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(branch_id, week_start) DO UPDATE SET sent_at = datetime('now'), sent_by = excluded.sent_by`
  ).run(branchId, weekStart, userId);
}

export function weeklySentAt(branchId: number, weekStart: string): string | null {
  const r = getDb().prepare(
    "SELECT sent_at FROM salesa_weekly_sent WHERE branch_id = ? AND week_start = ?"
  ).get(branchId, weekStart) as { sent_at: string } | undefined;
  return r?.sent_at ?? null;
}

// ── Settings (HOD LINE group) ───────────────────────────────────────────────

export function getLineGroupId(branchId: number): string | null {
  const r = getDb().prepare("SELECT line_group_id FROM salesa_settings WHERE branch_id = ?")
    .get(branchId) as { line_group_id: string | null } | undefined;
  return r?.line_group_id ?? null;
}

export function setLineGroupId(branchId: number, groupId: string | null): void {
  const clean = groupId && groupId.trim() ? groupId.trim() : null;
  getDb().prepare(
    `INSERT INTO salesa_settings (branch_id, line_group_id, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(branch_id) DO UPDATE SET line_group_id = excluded.line_group_id, updated_at = datetime('now')`
  ).run(branchId, clean);
}
