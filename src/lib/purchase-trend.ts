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

export function purchaseTrend(db: Database.Database, branchId: number, from: string, to: string, bucket: Bucket): PurchaseTrend {
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
     WHERE e.branch_id = ? AND e.review_status = 'confirmed' AND e.bill_date >= ? AND e.bill_date <= ?`
  ).all(branchId, from, to) as Array<{ d: string; vname: string | null; category: string | null; amt: number }>) {
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
  const rec = { lo: len - w, hi: len }, prev = { lo: len - 2 * w, hi: len - w };
  const sum = (a: number[], r: { lo: number; hi: number }) => a.slice(Math.max(0, r.lo), r.hi).reduce((s, v) => s + v, 0);
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
