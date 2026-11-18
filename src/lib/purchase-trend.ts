// Purchases per supplier set against sales (owner 2026-11-15): "last time sales were 30,000 and we bought 2,000 of
// ice; now sales are 20,000 and we buy 4,000" — the ratio purchase ÷ sales per supplier, over days / weeks / months,
// and how it moved between the recent window and the one before it. Read-only over salesa_daily + accounta_expenses.
import type Database from "better-sqlite3";

export type Bucket = "day" | "week" | "month";

export type PurchaseTrend = {
  bucket: Bucket;
  from: string; to: string;
  keys: string[];                 // bucket keys, oldest first (day = the date, week = its Monday, month = YYYY-MM)
  labels: string[];
  sales: number[];                // POS net sales per bucket (days with an import only)
  salesDays: number[];            // days with sales data per bucket
  total: number[];                // all suppliers together
  vendors: Array<{ name: string; category: string | null; spend: number; amounts: number[] }>;   // biggest spender first
};

export type VendorShift = {
  name: string;
  recent: { sales: number; purchase: number; ratio: number | null };
  previous: { sales: number; purchase: number; ratio: number | null };
  ratioDeltaPct: number | null;       // percentage points: recent ratio − previous ratio
  ratioChangePct: number | null;      // relative change of the ratio itself (3.3% → 10% = +200%)
  purchaseChangePct: number | null;   // % change of the purchase amount
  salesChangePct: number | null;
  /** buying more while selling less — the pattern worth a look */
  flag: "up_while_sales_down" | "ratio_up" | "ratio_down" | "steady" | "no_data";
};

/** How many buckets make "recent" (and the same number before it) for each view. Shared by the page and the LINE card. */
export const WINDOW: Record<Bucket, number> = { day: 7, week: 4, month: 3 };

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const TH_MON = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Monday of the week holding `d`. */
export function weekStart(d: string): string {
  const dow = (new Date(ms(d)).getUTCDay() + 6) % 7;   // Mon = 0
  return iso(ms(d) - dow * DAY);
}

export function bucketKey(d: string, bucket: Bucket): string {
  return bucket === "day" ? d : bucket === "week" ? weekStart(d) : d.slice(0, 7);
}

function bucketLabel(key: string, bucket: Bucket): string {
  if (bucket === "month") return `${TH_MON[Number(key.slice(5, 7)) - 1]} ${String((Number(key.slice(0, 4)) + 543) % 100).padStart(2, "0")}`;
  return `${Number(key.slice(8, 10))} ${TH_MON[Number(key.slice(5, 7)) - 1]}`;
}

/** Every bucket key from `from` to `to`, oldest first (so a quiet bucket still shows as a gap). */
function allKeys(from: string, to: string, bucket: Bucket): string[] {
  const out: string[] = [];
  let cur = bucketKey(from, bucket);
  const last = bucketKey(to, bucket);
  while (cur <= last) {
    out.push(cur);
    if (bucket === "day") cur = iso(ms(cur) + DAY);
    else if (bucket === "week") cur = iso(ms(cur) + 7 * DAY);
    else { const y = Number(cur.slice(0, 4)), m = Number(cur.slice(5, 7)); cur = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; }
  }
  return out;
}

/** How far back each view looks by default. */
export function defaultRange(bucket: Bucket, today: string): { from: string; to: string } {
  const back = bucket === "day" ? 29 : bucket === "week" ? 16 * 7 - 1 : 365;
  return { from: iso(ms(today) - back * DAY), to: today };
}

/** The category filter in the URL: blank category (bills with no category) is written "~none". */
export const NO_CATEGORY = "~none";
export const NO_CATEGORY_LABEL = "ไม่ระบุหมวด";
export const categoryLabel = (c: string): string => (c === "" || c === NO_CATEGORY ? NO_CATEGORY_LABEL : c);
/** URL value → the stored category ("" = none), or undefined for "all categories". */
export const parseCategoryParam = (v: string | undefined): string | undefined => (v == null || v === "" ? undefined : v === NO_CATEGORY ? "" : v);

/**
 * `category` undefined = every category; a string = only bills of that category ("" = bills with no category). Salaries, utilities, bank
 * fees and raw materials sit in different categories, so a ratio only means something within one of them.
 */
export function purchaseTrend(db: Database.Database, branchId: number, from: string, to: string, bucket: Bucket, category?: string): PurchaseTrend {
  const keys = allKeys(from, to, bucket);
  const idx = new Map(keys.map((k, i) => [k, i]));
  const n = keys.length;
  const sales = new Array<number>(n).fill(0), salesDays = new Array<number>(n).fill(0), total = new Array<number>(n).fill(0);

  for (const r of db.prepare(
    "SELECT sale_date d, nett FROM salesa_daily WHERE branch_id = ? AND has_sales = 1 AND sale_date >= ? AND sale_date <= ?"
  ).all(branchId, from, to) as Array<{ d: string; nett: number }>) {
    const i = idx.get(bucketKey(r.d, bucket));
    if (i != null) { sales[i] += r.nett; salesDays[i]++; }
  }

  // Confirmed bills with a supplier, by the bill (accrual) date — the same date ACCOUNTA books it on. The supplier is the
  // master name when the bill is linked, else the typed name; blank suppliers are not a supplier and are left out.
  const byVendor = new Map<string, { category: string | null; spend: number; amounts: number[] }>();
  for (const r of db.prepare(`
    SELECT e.bill_date d, COALESCE(NULLIF(TRIM(v.name), ''), NULLIF(TRIM(e.vendor_name), '')) AS vname, e.category, e.amount_total AS amt
      FROM accounta_expenses e LEFT JOIN accounta_vendors v ON v.id = e.vendor_id
     WHERE e.branch_id = ? AND e.review_status = 'confirmed' AND e.bill_date >= ? AND e.bill_date <= ?
       AND (? IS NULL OR COALESCE(e.category, '') = ?)`
  ).all(branchId, from, to, category ?? null, category ?? null) as Array<{ d: string; vname: string | null; category: string | null; amt: number }>) {
    if (!r.vname) continue;
    const i = idx.get(bucketKey(r.d, bucket));
    if (i == null) continue;
    let v = byVendor.get(r.vname);
    if (!v) { v = { category: r.category, spend: 0, amounts: new Array<number>(n).fill(0) }; byVendor.set(r.vname, v); }
    v.amounts[i] += r.amt; v.spend += r.amt; total[i] += r.amt;
  }

  const vendors = [...byVendor.entries()].map(([name, v]) => ({ name, category: v.category, spend: round2(v.spend), amounts: v.amounts.map(round2) }))
    .sort((a, b) => b.spend - a.spend);
  return { bucket, from, to, keys, labels: keys.map((k) => bucketLabel(k, bucket)), sales: sales.map(round2), salesDays, total: total.map(round2), vendors };
}

/** purchase ÷ sales as a percentage; null when there are no sales to compare with. */
export function ratioPct(purchase: number, sales: number): number | null {
  return sales > 0 ? round2((purchase / sales) * 100) : null;
}

const pctChange = (now: number, before: number): number | null => (before > 0 ? round2(((now - before) / before) * 100) : null);

/**
 * The last `n` buckets against the `n` before them, per supplier (and "รวมทุกผู้ขาย" first). Flags the case the owner asked
 * about: the supplier is bought from more while sales went down.
 */
export function vendorShifts(t: PurchaseTrend, n: number): VendorShift[] {
  const len = t.keys.length;
  const w = Math.max(1, Math.min(n, Math.floor(len / 2)));
  return shiftsOver(t, { lo: len - w, hi: len }, { lo: len - 2 * w, hi: len - w });
}

type Span = { lo: number; hi: number };
function shiftsOver(t: PurchaseTrend, rec: Span, prev: Span): VendorShift[] {
  const sum = (a: number[], r: Span) => a.slice(Math.max(0, r.lo), r.hi).reduce((s, v) => s + v, 0);
  const one = (name: string, amounts: number[]): VendorShift => {
    const rs = sum(t.sales, rec), ps = sum(t.sales, prev), rp = sum(amounts, rec), pp = sum(amounts, prev);
    const rr = ratioPct(rp, rs), pr = ratioPct(pp, ps);
    const delta = rr != null && pr != null ? round2(rr - pr) : null;
    // relative change from the unrounded ratios (the shown 2-decimal ratios would give 200.3 for 3.33% → 10%)
    const rel = ps > 0 && rs > 0 && pp > 0 ? round2((((rp / rs) / (pp / ps)) - 1) * 100) : null;
    const salesCh = pctChange(rs, ps), purCh = pctChange(rp, pp);
    let flag: VendorShift["flag"] = "no_data";
    if (delta != null) {
      if (rp > pp && rs < ps) flag = "up_while_sales_down";
      // a small supplier's ratio moves in fractions of a point, so judge the change relative to its own ratio
      else if (pp === 0 && rp > 0) flag = "ratio_up";                    // newly bought from
      else if (rel != null && rel >= 20) flag = "ratio_up";
      else if (rel != null && rel <= -20) flag = "ratio_down";
      else flag = "steady";
    }
    return { name, recent: { sales: round2(rs), purchase: round2(rp), ratio: rr }, previous: { sales: round2(ps), purchase: round2(pp), ratio: pr }, ratioDeltaPct: delta, ratioChangePct: rel, purchaseChangePct: purCh, salesChangePct: salesCh, flag };
  };
  return [one("รวมทุกผู้ขาย", t.total), ...t.vendors.map((v) => one(v.name, v.amounts))];
}

// ── Month-to-date (owner 2026-11-18): bills come in lumps (rent, electricity, a monthly invoice), so a 7-day window against the 7 days
// before swings wildly. MTD compares this month so far with the SAME days of last month: 1–18 Nov against 1–18 Oct.

export type View = Bucket | "mtd";
export type MtdRanges = { from: string; to: string; recent: { from: string; to: string; label: string }; previous: { from: string; to: string; label: string } };

const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();   // m = 1..12
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** This month from day 1 to `today`, and last month from day 1 to the same day-of-month (capped at that month's length). */
export function mtdRanges(today: string): MtdRanges {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)), d = Number(today.slice(8, 10));
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  const pd = Math.min(d, daysInMonth(py, pm));
  const rFrom = `${y}-${pad2(m)}-01`, pFrom = `${py}-${pad2(pm)}-01`, pTo = `${py}-${pad2(pm)}-${pad2(pd)}`;
  return {
    from: pFrom, to: today,
    recent: { from: rFrom, to: today, label: `1–${d} ${TH_MON[m - 1]}` },
    previous: { from: pFrom, to: pTo, label: `1–${pd} ${TH_MON[pm - 1]}` }
  };
}

/** `t` must be a day-bucket trend covering r.from..r.to. */
export function vendorShiftsMtd(t: PurchaseTrend, r: MtdRanges): VendorShift[] {
  const span = (from: string, to: string): Span => {
    const lo = t.keys.findIndex((k) => k >= from);
    let hi = 0; t.keys.forEach((k, i) => { if (k <= to) hi = i + 1; });
    return { lo: lo < 0 ? t.keys.length : lo, hi };
  };
  return shiftsOver(t, span(r.recent.from, r.recent.to), span(r.previous.from, r.previous.to));
}

/**
 * The suppliers worth a LINE card: bought from MORE relative to sales — the purchase ratio rose (including "buying more while sales fell" and a
 * supplier newly bought from). The all-suppliers row is context, not a supplier, so it is left out. Worst first: buying more while sales fell,
 * then the biggest rise in the ratio.
 */
export function buyingMoreShifts(shifts: VendorShift[]): VendorShift[] {
  return shifts
    .filter((s) => s.name !== "รวมทุกผู้ขาย" && (s.flag === "up_while_sales_down" || s.flag === "ratio_up"))
    .sort((a, b) => (a.flag === b.flag ? 0 : a.flag === "up_while_sales_down" ? -1 : 1) || (b.ratioDeltaPct ?? -Infinity) - (a.ratioDeltaPct ?? -Infinity));
}

/** The categories that have confirmed bills with a supplier in the range, biggest spend first ("" = no category). */
export function listPurchaseCategories(db: Database.Database, branchId: number, from: string, to: string): Array<{ name: string; spend: number }> {
  return (db.prepare(`
    SELECT COALESCE(e.category, '') AS name, SUM(e.amount_total) AS spend
      FROM accounta_expenses e LEFT JOIN accounta_vendors v ON v.id = e.vendor_id
     WHERE e.branch_id = ? AND e.review_status = 'confirmed' AND e.bill_date >= ? AND e.bill_date <= ?
       AND COALESCE(NULLIF(TRIM(v.name), ''), NULLIF(TRIM(e.vendor_name), '')) IS NOT NULL
     GROUP BY COALESCE(e.category, '') ORDER BY spend DESC
  `).all(branchId, from, to) as Array<{ name: string; spend: number }>).map((r) => ({ name: r.name, spend: round2(r.spend) }));
}
