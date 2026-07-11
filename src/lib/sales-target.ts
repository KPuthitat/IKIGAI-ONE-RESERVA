import { getDb } from "@/lib/db";

// Monthly sales-vs-target progress (owner 2026-07-11). A single source of
// truth for "ยอดขายเดือนนี้คิดเป็นกี่ % ของเป้าที่ตั้งไว้", reused by the
// ACCOUNTA บัญชีรายรับรายจ่าย page and the shift-close LINE card.
//
// The target is the EXISTING monthly sales target — branches.material_target_sales
// (X, baht/month, set in persona branch settings). Progress = ยอดขายสะสม
// ทั้งเดือน ÷ X. Per-branch: each branch has its own X.
//
// The month-to-date sales figure: callers on the ACCOUNTA page pass the
// ledger's salesRevenue (via `monthSalesOverride`) so the bar matches the
// page's "รายรับ (ยอดขาย)" and the โควตา card exactly. When no override is
// given we fall back to summing branch_daily_revenue (the shift-close feed),
// which is what the LINE card / any caller without a ledger dashboard uses.
//
// hasTarget is keyed on X > 0 (a target is set) rather than the
// material_quota_enabled flag — the owner wants the bar whenever a monthly
// target exists, independent of whether the material-purchase quota feature
// is on for that branch.

export type SalesTargetProgress = {
  /** True when the branch has a monthly sales target set (X > 0). */
  hasTarget: boolean;
  /** X — monthly sales target in baht (branches.material_target_sales). */
  monthlyTarget: number;
  /** Sum of branch_daily_revenue for `date`'s month up to and incl. today. */
  monthToDateSales: number;
  /** monthToDateSales ÷ monthlyTarget × 100, one decimal. Can exceed 100. */
  monthPct: number;
  /** YYYY-MM-DD (Bangkok) the figures are for. */
  date: string;
};

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Month-to-date sales progress against the branch's monthly sales target.
 *  `date` is YYYY-MM-DD (Bangkok). Pass `monthSalesOverride` (e.g. the ledger
 *  dashboard's salesRevenue) to base the bar on that figure instead of the
 *  branch_daily_revenue sum, so it matches the rest of the ACCOUNTA page. */
export function salesTargetProgress(
  branchId: number,
  date: string,
  monthSalesOverride?: number | null
): SalesTargetProgress {
  const db = getDb();
  const b = db
    .prepare("SELECT material_target_sales AS x FROM branches WHERE id = ?")
    .get(branchId) as { x: number } | undefined;
  const monthlyTarget = Math.max(0, Number(b?.x) || 0);

  let monthToDateSales: number;
  if (monthSalesOverride != null) {
    monthToDateSales = round2(Math.max(0, Number(monthSalesOverride) || 0));
  } else {
    const month = date.slice(0, 7); // YYYY-MM
    const mtd = db
      .prepare(
        "SELECT COALESCE(SUM(revenue), 0) AS s FROM branch_daily_revenue WHERE branch_id = ? AND substr(date, 1, 7) = ?"
      )
      .get(branchId, month) as { s: number };
    monthToDateSales = round2(Math.max(0, Number(mtd?.s) || 0));
  }

  const monthPct = monthlyTarget > 0 ? round1((monthToDateSales / monthlyTarget) * 100) : 0;

  return {
    hasTarget: monthlyTarget > 0,
    monthlyTarget,
    monthToDateSales,
    monthPct,
    date
  };
}
