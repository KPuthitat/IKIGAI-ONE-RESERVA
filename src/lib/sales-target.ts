import { getDb } from "@/lib/db";

// Daily sales-vs-target progress (owner 2026-07-11). A single source of
// truth for "ยอดขายวันนี้ คิดเป็นกี่ % ของเป้าที่ตั้งไว้", reused by the
// ACCOUNTA บัญชีรายรับรายจ่าย page and the shift-close LINE card.
//
// The target the owner picked (2026-07-11) is the EXISTING monthly sales
// target — branches.material_target_sales (X, baht/month, set in persona
// branch settings). We spread it evenly across the calendar month so a
// day's target = X ÷ (days in that month). Per-branch: each branch has its
// own X and its own branch_daily_revenue row for the day.
//
// hasTarget is keyed on X > 0 (a target is set) rather than the
// material_quota_enabled flag — the owner wants the bar whenever a monthly
// target exists, independent of whether the material-purchase quota feature
// is turned on for that branch.

export type DailySalesTarget = {
  /** True when the branch has a monthly sales target set (X > 0). */
  hasTarget: boolean;
  /** X — monthly sales target in baht (branches.material_target_sales). */
  monthlyTarget: number;
  /** X ÷ daysInMonth — the day's target in baht. 0 when no target. */
  dailyTarget: number;
  /** Recorded sales for `date` (branch_daily_revenue), 0 when none yet. */
  todaySales: number;
  /** todaySales ÷ dailyTarget × 100, one decimal. Can exceed 100. 0 when
   *  there's no target to compare against. */
  pct: number;
  /** YYYY-MM-DD (Bangkok) the figures are for. */
  date: string;
  /** Calendar days in `date`'s month — the divisor for dailyTarget. */
  daysInMonth: number;
};

/** Today's (or any day's) sales progress against the branch's daily sales
 *  target, derived from the monthly target. `date` is YYYY-MM-DD. */
export function dailySalesTarget(branchId: number, date: string): DailySalesTarget {
  const db = getDb();
  const b = db
    .prepare("SELECT material_target_sales AS x FROM branches WHERE id = ?")
    .get(branchId) as { x: number } | undefined;
  const monthlyTarget = Math.max(0, Number(b?.x) || 0);

  const [yy, mm] = date.split("-").map(Number);
  // Day 0 of the next month = last day of this month → days in month.
  const daysInMonth = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const dailyTarget =
    monthlyTarget > 0 ? Math.round((monthlyTarget / daysInMonth) * 100) / 100 : 0;

  const rev = db
    .prepare("SELECT revenue FROM branch_daily_revenue WHERE branch_id = ? AND date = ?")
    .get(branchId, date) as { revenue: number } | undefined;
  const todaySales = Math.max(0, Number(rev?.revenue) || 0);

  const pct = dailyTarget > 0 ? Math.round((todaySales / dailyTarget) * 1000) / 10 : 0;

  return {
    hasTarget: monthlyTarget > 0,
    monthlyTarget,
    dailyTarget,
    todaySales,
    pct,
    date,
    daysInMonth
  };
}
