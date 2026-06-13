import { getDb } from "@/lib/db";
import { computeWorkedMinutesByDay } from "@/lib/service-charge";

// Daily Cost-of-Labour (%COL) for the management dashboard (owner 2026-06-13).
// Labour cost uses ACTUAL clocked hours (time_entries) — not the rostered plan
// — times each staff's rate. COL% = labour cost / that day's recorded sales.
// This is the daily, actual-hours counterpart to calcColPct() in
// ascenda-engine.ts (which is monthly + rostered for the KPI scorecard).

export type DailyColRow = {
  date: string; // YYYY-MM-DD (Bangkok)
  revenue: number | null; // recorded daily sales, null when not entered
  laborCost: number; // baht, from actual clocked hours × rate
  colPct: number | null; // laborCost / revenue × 100, null when no revenue
};

/** FT monthly salary → nominal hourly. Mirrors calcColPct: 22 working days
 *  × 8 hours, so the two COL figures stay consistent. */
function ftHourly(monthlySalary: number): number {
  return monthlySalary / 22 / 8;
}

/** Daily %COL for a branch over the last `days` calendar days (Bangkok),
 *  newest first. */
export function getDailyColRows(branchId: number, days: number): DailyColRow[] {
  const db = getDb();
  const todayBkk = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

  // Build the date list newest→oldest. Anchor at noon UTC so subtracting
  // whole days never slips across a timezone boundary.
  const base = new Date(`${todayBkk}T12:00:00Z`).getTime();
  const dates: string[] = [];
  for (let i = 0; i < days; i++) {
    dates.push(new Date(base - i * 86_400_000).toISOString().slice(0, 10));
  }
  const oldest = dates[dates.length - 1];
  const startIso = new Date(`${oldest}T00:00:00+07:00`).toISOString();
  const endIso = new Date(`${todayBkk}T23:59:59+07:00`).toISOString();

  const entries = db
    .prepare(
      `SELECT user_id, ts, type FROM time_entries
       WHERE branch_id = ? AND ts >= ? AND ts <= ?
       ORDER BY ts ASC`
    )
    .all(branchId, startIso, endIso) as Array<{
    user_id: number;
    ts: string;
    type: "in" | "out";
  }>;

  const minutesByDay = computeWorkedMinutesByDay(entries); // Map<date, Map<userId, minutes>>

  // Rate lookup for every user that clocked in the window.
  const userIds = new Set<number>();
  for (const m of minutesByDay.values()) for (const uid of m.keys()) userIds.add(uid);
  const rateByUser = new Map<
    number,
    { type: string | null; hourly: number | null; monthly: number | null }
  >();
  if (userIds.size > 0) {
    const ph = [...userIds].map(() => "?").join(",");
    const urows = db
      .prepare(
        `SELECT id, employment_type, hourly_rate, monthly_salary
         FROM users WHERE id IN (${ph})`
      )
      .all(...userIds) as Array<{
      id: number;
      employment_type: string | null;
      hourly_rate: number | null;
      monthly_salary: number | null;
    }>;
    for (const u of urows) {
      rateByUser.set(u.id, {
        type: u.employment_type,
        hourly: u.hourly_rate,
        monthly: u.monthly_salary
      });
    }
  }

  // Recorded sales per date.
  const revRows = db
    .prepare(
      `SELECT date, revenue FROM branch_daily_revenue
       WHERE branch_id = ? AND date >= ? AND date <= ?`
    )
    .all(branchId, oldest, todayBkk) as Array<{ date: string; revenue: number }>;
  const revByDate = new Map(revRows.map((r) => [r.date, r.revenue]));

  return dates.map((date) => {
    const userMin = minutesByDay.get(date);
    let laborCost = 0;
    if (userMin) {
      for (const [uid, mins] of userMin) {
        const r = rateByUser.get(uid);
        if (!r) continue;
        const hours = mins / 60;
        if (r.type === "pt" && r.hourly) laborCost += hours * r.hourly;
        else if (r.type === "ft" && r.monthly) laborCost += hours * ftHourly(r.monthly);
      }
    }
    laborCost = Math.round(laborCost * 100) / 100;
    const revenue = revByDate.has(date) ? revByDate.get(date)! : null;
    const colPct =
      revenue && revenue > 0 ? Math.round((laborCost / revenue) * 1000) / 10 : null;
    return { date, revenue, laborCost, colPct };
  });
}
