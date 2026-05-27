// ASCENDA auto-calculator engine (2026-05-27 — Phase 4).
//
// Three auto kinds:
//   • attendance_pct   per branch — share of planned shift-days the
//                      team missed (absent + on approved leave + late
//                      arrival). Lower = better.
//   • col_pct_auto     per branch — Cost of Labour as a percentage
//                      of trailing-3-month average revenue.
//   • sales_growth_pct company   — month-over-month change in total
//                      revenue across every branch.
//
// Owner direction: these MUST recompute themselves when the page
// loads; admin shouldn't have to click a "run" button. Cost is small
// (a few aggregate queries per KPI per branch). Manual KPI rows
// (incidents / complaints / orders / COG) are untouched — engine
// only writes rows it owns (computed_by_system = 1).
//
// Each calculator returns either a number or null (= insufficient
// data for the period). Null produces a "pending" status so the
// dashboard cell shows "—" instead of a fake 0.

import { getDb } from "./db";
import {
  evaluateStatus,
  isAutoKind,
  listKpis,
  monthlyBranchRevenue,
  recentPeriodKeys,
  type AscendaKpi
} from "./ascenda";

/** % of planned shift-DAYS the branch's team missed. A shift-day is
 *  one (user × date) cell in the roster — counted as a "miss" when:
 *    - the user has an approved leave_request covering that date, OR
 *    - the user has NO time_entry on that date, OR
 *    - the user's first time_entry on that date is more than 5 min
 *      after the shift's scheduled start_time.
 *  Returns null when the roster is empty (no plan to compare against).
 *  The 5-min grace mirrors the late-detection rule used elsewhere in
 *  the PERSONA module. */
function calcAttendancePct(branchId: number, periodKey: string): number | null {
  const db = getDb();
  // First + last day of the period (UTC-safe — these are calendar
  // strings only, no timezone math).
  const [y, m] = periodKey.split("-").map(Number);
  const firstDay = `${periodKey}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

  // All work-assignments for the branch in the period. day_off rows
  // are skipped via the kind='work' filter.
  const assignments = db.prepare(`
    SELECT a.user_id, a.assignment_date AS d, sc.start_time
    FROM roster_assignments a
    JOIN shift_codes sc ON sc.id = a.shift_code_id
    WHERE a.branch_id = ?
      AND sc.kind = 'work'
      AND a.assignment_date >= ?
      AND a.assignment_date <= ?
  `).all(branchId, firstDay, lastDay) as Array<{
    user_id: number; d: string; start_time: string;
  }>;
  if (assignments.length === 0) return null;

  // Approved leaves overlapping the period (any user).
  const leaves = db.prepare(`
    SELECT user_id, date_from, date_to
    FROM leave_requests
    WHERE status = 'approved'
      AND date_from <= ?
      AND date_to >= ?
  `).all(lastDay, firstDay) as Array<{
    user_id: number; date_from: string; date_to: string;
  }>;
  const leaveByUser = new Map<number, Array<{ from: string; to: string }>>();
  for (const l of leaves) {
    const arr = leaveByUser.get(l.user_id) ?? [];
    arr.push({ from: l.date_from, to: l.date_to });
    leaveByUser.set(l.user_id, arr);
  }

  // First clock-in (type='in') per (user, date) for the period at
  // this branch. Used to detect absent (no row) + late (row > planned
  // + 5). The time_entries table uses `ts` + `type` columns — earlier
  // versions of this file used the wrong column names (`in_ts`) and
  // crashed the page; corrected to match daily-attendance-summary.ts.
  const clockIns = db.prepare(`
    SELECT user_id,
           substr(ts, 1, 10) AS d,
           MIN(ts) AS ts
    FROM time_entries
    WHERE branch_id = ?
      AND type = 'in'
      AND substr(ts, 1, 10) >= ?
      AND substr(ts, 1, 10) <= ?
    GROUP BY user_id, substr(ts, 1, 10)
  `).all(branchId, firstDay, lastDay) as Array<{
    user_id: number; d: string; ts: string;
  }>;
  const clockKey = (u: number, d: string) => `${u}:${d}`;
  const clockByKey = new Map<string, string>();
  for (const c of clockIns) clockByKey.set(clockKey(c.user_id, c.d), c.ts);

  let misses = 0;
  for (const a of assignments) {
    // On approved leave? Counts as a miss.
    const userLeaves = leaveByUser.get(a.user_id);
    if (userLeaves) {
      const covered = userLeaves.some((l) => a.d >= l.from && a.d <= l.to);
      if (covered) { misses += 1; continue; }
    }
    const actualIn = clockByKey.get(clockKey(a.user_id, a.d));
    if (!actualIn) { misses += 1; continue; }  // absent
    // Late detection — compare actual clock-in to planned start +
    // 5 min grace. Both timestamps are ISO; build the planned-start
    // anchor for the same Bangkok-local date.
    const plannedTs = `${a.d}T${a.start_time}:00+07:00`;
    const lateMs = new Date(actualIn).getTime()
      - new Date(plannedTs).getTime();
    if (lateMs > 5 * 60_000) { misses += 1; }
  }
  return Math.round((misses / assignments.length) * 1000) / 10;
}

/** Cost of Labour % = (planned monthly labour cost) / (avg monthly
 *  revenue over the trailing 3 months) × 100.
 *  Planned labour cost = Σ for each roster_assignment in the period:
 *    PT staff:  hours × hourly_rate
 *    FT staff:  hours × (monthly_salary / 22 working days / 8 hours)
 *  Returns null when revenue is missing for ALL three trailing
 *  months (can't divide by zero meaningfully). */
function calcColPct(branchId: number, periodKey: string): number | null {
  const db = getDb();
  const [y, m] = periodKey.split("-").map(Number);
  const firstDay = `${periodKey}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

  // Pull every work-assignment for the period joined with the shift
  // code times + user payroll fields. One row per (user, date, slot).
  const rows = db.prepare(`
    SELECT a.user_id,
           sc.start_time, sc.end_time,
           u.employment_type, u.hourly_rate, u.monthly_salary
    FROM roster_assignments a
    JOIN shift_codes sc ON sc.id = a.shift_code_id
    JOIN users u ON u.id = a.user_id
    WHERE a.branch_id = ?
      AND sc.kind = 'work'
      AND a.assignment_date >= ?
      AND a.assignment_date <= ?
  `).all(branchId, firstDay, lastDay) as Array<{
    user_id: number;
    start_time: string; end_time: string;
    employment_type: "pt" | "ft" | null;
    hourly_rate: number | null;
    monthly_salary: number | null;
  }>;
  if (rows.length === 0) return null;

  // Hours between "HH:MM" strings on the same day. Wrap-around (end
  // before start = overnight) treated as next-day end.
  const hoursBetween = (s: string, e: string): number => {
    const [sh, sm] = s.split(":").map(Number);
    const [eh, em] = e.split(":").map(Number);
    let minutes = (eh * 60 + em) - (sh * 60 + sm);
    if (minutes < 0) minutes += 24 * 60;
    return minutes / 60;
  };

  let cost = 0;
  for (const r of rows) {
    const hours = hoursBetween(r.start_time, r.end_time);
    if (r.employment_type === "pt" && r.hourly_rate) {
      cost += hours * r.hourly_rate;
    } else if (r.employment_type === "ft" && r.monthly_salary) {
      // 22 working days × 8 hours = nominal monthly hours.
      // Owner can tune this if needed; conservative default.
      const ftHourly = r.monthly_salary / 22 / 8;
      cost += hours * ftHourly;
    }
    // Rows with no payroll fields contribute zero — admin should
    // set those before the calc reads as truthful.
  }
  if (cost === 0) return null;

  // Trailing 3 months of revenue (excluding the period itself —
  // owner spec: "รายได้เฉลี่ยย้อนหลัง 3 เดือน"). When all 3 are
  // zero/missing, we have no denominator to use; signal "pending".
  const trailingKeys = recentPeriodKeys(periodKey, 4).slice(0, 3);
  // recentPeriodKeys returns oldest→newest ending at periodKey, so
  // we slice the first 3 = the 3 months BEFORE periodKey.
  const trailingTotals = trailingKeys.map((k) =>
    monthlyBranchRevenue(branchId, k)
  );
  const validMonths = trailingTotals.filter((v) => v > 0);
  if (validMonths.length === 0) return null;
  const avgRevenue = validMonths.reduce((a, b) => a + b, 0) / validMonths.length;
  if (avgRevenue === 0) return null;

  return Math.round((cost / avgRevenue) * 1000) / 10;
}

/** Sales growth % = (this-month total revenue / last-month total
 *  revenue − 1) × 100. Totals are summed across every branch (this
 *  is the only company-scope KPI today). Returns null when either
 *  month has zero revenue. */
function calcSalesGrowthPct(periodKey: string): number | null {
  const db = getDb();
  const trailing = recentPeriodKeys(periodKey, 2);
  // trailing = [prevMonth, periodKey]
  const [prevKey, curKey] = trailing;
  const sumFor = (k: string) => (db.prepare(`
    SELECT COALESCE(SUM(revenue), 0) AS total
    FROM branch_daily_revenue
    WHERE substr(date, 1, 7) = ?
  `).get(k) as { total: number }).total;
  const curTotal = sumFor(curKey);
  const prevTotal = sumFor(prevKey);
  if (prevTotal === 0 || curTotal === 0) return null;
  return Math.round(((curTotal / prevTotal) - 1) * 1000) / 10;
}

// ── Orchestrator ───────────────────────────────────────────────────

/** Run every auto-kind KPI for the period and upsert the results.
 *  Idempotent — safe to call from a page-load server component on
 *  every render. Returns the number of rows touched so callers can
 *  log if they want a heartbeat. */
export function runAutoCalculators(periodKey: string): number {
  const db = getDb();
  const branches = db.prepare(
    "SELECT id FROM branches WHERE status != 'closed'"
  ).all() as Array<{ id: number }>;

  const allKpis = listKpis(undefined, true).filter((k) => isAutoKind(k.kind));
  if (allKpis.length === 0) return 0;

  let touched = 0;
  const upsert = (kpi: AscendaKpi, branchId: number | null, value: number | null) => {
    const status = evaluateStatus(value, kpi.target_value, kpi.target_op);
    const now = new Date().toISOString();
    // INSERT OR REPLACE via the UNIQUE (kpi_id, branch_id, period_key)
    // index. Caveat: in SQLite NULL ≠ NULL for UNIQUE, so company-
    // scope rows (branch_id NULL) can duplicate — we guard against
    // that with an explicit existing-row lookup.
    const existing = db.prepare(`
      SELECT id FROM ascenda_results
      WHERE kpi_id = ? AND period_key = ?
        ${branchId == null ? "AND branch_id IS NULL" : "AND branch_id = ?"}
    `).get(...(branchId == null ? [kpi.id, periodKey] : [kpi.id, periodKey, branchId])) as
      | { id: number } | undefined;
    if (existing) {
      db.prepare(`
        UPDATE ascenda_results
        SET actual_value = ?, status = ?, computed_by_system = 1,
            recorded_at = ?
        WHERE id = ?
      `).run(value, status, now, existing.id);
    } else {
      db.prepare(`
        INSERT INTO ascenda_results
          (kpi_id, branch_id, period_key, actual_value, status,
           computed_by_system, recorded_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)
      `).run(kpi.id, branchId, periodKey, value, status, now);
    }
    touched += 1;
  };

  for (const kpi of allKpis) {
    if (kpi.scope === "company") {
      // Only sales_growth_pct fits here today; the calculator chooses
      // based on kind. If a future company-scope auto KPI shows up,
      // add a case to the switch.
      let v: number | null = null;
      if (kpi.kind === "sales_growth_pct") v = calcSalesGrowthPct(periodKey);
      upsert(kpi, null, v);
    } else {
      for (const b of branches) {
        let v: number | null = null;
        if (kpi.kind === "attendance_pct")  v = calcAttendancePct(b.id, periodKey);
        else if (kpi.kind === "col_pct_auto") v = calcColPct(b.id, periodKey);
        else if (kpi.kind === "sales_growth_pct") v = calcSalesGrowthPct(periodKey);
        upsert(kpi, b.id, v);
      }
    }
  }
  return touched;
}
