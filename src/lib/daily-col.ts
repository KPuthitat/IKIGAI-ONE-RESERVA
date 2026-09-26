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

/** Per-day labour cost from clocked minutes × each staff's stored rate — the
 *  single rate model shared by the branch (getDailyColRows) and company
 *  (companyMonthLabor) COL views. PT: hours × hourly_rate; FT: hours ×
 *  monthly_salary/22/8. Non-clocking staff contribute nothing (no minutes). */
function laborCostByDay(
  db: ReturnType<typeof getDb>, minutesByDay: Map<string, Map<number, number>>
): Map<string, number> {
  const userIds = new Set<number>();
  for (const m of minutesByDay.values()) for (const uid of m.keys()) userIds.add(uid);
  const rateByUser = new Map<number, { type: string | null; hourly: number | null; monthly: number | null }>();
  if (userIds.size > 0) {
    const ph = [...userIds].map(() => "?").join(",");
    for (const u of db.prepare(
      `SELECT id, employment_type, hourly_rate, monthly_salary FROM users WHERE id IN (${ph})`
    ).all(...userIds) as Array<{ id: number; employment_type: string | null; hourly_rate: number | null; monthly_salary: number | null }>) {
      rateByUser.set(u.id, { type: u.employment_type, hourly: u.hourly_rate, monthly: u.monthly_salary });
    }
  }
  const out = new Map<string, number>();
  for (const [date, userMin] of minutesByDay) {
    let cost = 0;
    for (const [uid, mins] of userMin) {
      const r = rateByUser.get(uid);
      if (!r) continue;
      const hours = mins / 60;
      if (r.type === "pt" && r.hourly) cost += hours * r.hourly;
      else if (r.type === "ft" && r.monthly) cost += hours * ftHourly(r.monthly);
    }
    out.set(date, Math.round(cost * 100) / 100);
  }
  return out;
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
  const laborByDay = laborCostByDay(db, minutesByDay);

  // Recorded sales per date.
  const revRows = db
    .prepare(
      `SELECT date, revenue FROM branch_daily_revenue
       WHERE branch_id = ? AND date >= ? AND date <= ?`
    )
    .all(branchId, oldest, todayBkk) as Array<{ date: string; revenue: number }>;
  const revByDate = new Map(revRows.map((r) => [r.date, r.revenue]));

  return dates.map((date) => {
    const laborCost = laborByDay.get(date) ?? 0;
    const revenue = revByDate.has(date) ? revByDate.get(date)! : null;
    const colPct =
      revenue && revenue > 0 ? Math.round((laborCost / revenue) * 1000) / 10 : null;
    return { date, revenue, laborCost, colPct };
  });
}

// ── ANALYTICA: today's COL snapshot for one branch (owner 2026-09-26) ────────
// "วันนี้มีพนักงานเข้างานกี่คน (ประจำ/พาร์ทไทม์), เป็นต้นทุนแรงงานกี่บาท, กี่ %
// ของยอดขายวันนี้." Headcount counts everyone who clocked IN today (including
// staff still on shift); labour cost/COL% use completed shifts × each staff's
// rate (an open shift firms up when they clock out), matching the rest of COL.

export type TodayCol = {
  date: string;             // Bangkok YYYY-MM-DD
  headcount: number;        // distinct real staff who clocked in today
  ftCount: number;          // of those, full-time
  ptCount: number;          // of those, part-time
  otherCount: number;       // of those, neither (contract/unset) — so the split reconciles
  laborCost: number;        // baht — worked hours × rate, open shifts counted up to now
  salesNett: number | null; // this branch's POS nett today
  colPct: number | null;    // laborCost / salesNett × 100
};

export function branchTodayCol(branchId: number, todayBkk: string): TodayCol {
  const db = getDb();
  const startIso = new Date(`${todayBkk}T00:00:00+07:00`).toISOString();
  const endIso = new Date(`${todayBkk}T23:59:59+07:00`).toISOString();
  const rawEntries = db.prepare(
    `SELECT user_id, ts, type FROM time_entries
     WHERE branch_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC`
  ).all(branchId, startIso, endIso) as Array<{ user_id: number; ts: string; type: "in" | "out" }>;

  // Restrict to real staff — exclude disabled/resigned and test accounts, and
  // capture employment_type in the SAME lookup for the FT/PT split (CLAUDE.md).
  const allIds = [...new Set(rawEntries.map((e) => e.user_id))];
  const empByUser = new Map<number, string | null>();
  if (allIds.length) {
    const ph = allIds.map(() => "?").join(",");
    for (const u of db.prepare(
      `SELECT id, employment_type FROM users
        WHERE id IN (${ph}) AND status NOT IN ('disabled','resigned') AND COALESCE(is_test_account,0) = 0`
    ).all(...allIds) as Array<{ id: number; employment_type: string | null }>) {
      empByUser.set(u.id, u.employment_type);
    }
  }
  const entries = rawEntries.filter((e) => empByUser.has(e.user_id));

  // Close any still-open shift at "now" so the cost is live through the day, not
  // 0 until people clock out. (No effect on a fully clocked-out past day.)
  const nowIso = new Date().toISOString();
  const net = new Map<number, number>();
  for (const e of entries) net.set(e.user_id, (net.get(e.user_id) ?? 0) + (e.type === "in" ? 1 : -1));
  const withOpen = [...entries];
  for (const [uid, n] of net) if (n > 0) withOpen.push({ user_id: uid, ts: nowIso, type: "out" });
  withOpen.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const laborCost = laborCostByDay(db, computeWorkedMinutesByDay(withOpen)).get(todayBkk) ?? 0;

  // Headcount = distinct real staff with a clock-IN today (incl. still on shift).
  const inUserIds = [...new Set(entries.filter((e) => e.type === "in").map((e) => e.user_id))];
  let ftCount = 0, ptCount = 0;
  for (const uid of inUserIds) {
    const t = empByUser.get(uid);
    if (t === "ft") ftCount++;
    else if (t === "pt") ptCount++;
  }
  const headcount = inUserIds.length;

  const salesRow = db.prepare(
    `SELECT SUM(nett) AS nett FROM salesa_daily WHERE branch_id = ? AND has_sales = 1 AND sale_date = ?`
  ).get(branchId, todayBkk) as { nett: number | null } | undefined;
  const salesNett = salesRow?.nett != null ? Math.round(salesRow.nett * 100) / 100 : null;
  const colPct = salesNett && salesNett > 0 ? Math.round((laborCost / salesNett) * 1000) / 10 : null;

  return { date: todayBkk, headcount, ftCount, ptCount, otherCount: headcount - ftCount - ptCount, laborCost, salesNett, colPct };
}

// ── ANALYTICA: company-wide daily labour cost for a month (owner 2026-09-24) ──

export type CompanyLaborDay = {
  date: string;            // YYYY-MM-DD (Bangkok)
  laborCost: number;       // baht — actual clocked hours × each staff's rate
  salesNett: number | null;// SALESA daily nett (company), null when no import that day
  colPct: number | null;   // laborCost / salesNett × 100
};

export type CompanyMonthLabor = {
  days: CompanyLaborDay[]; // date order, 1..throughDay of the month
  dayCount: number;        // elapsed days in the window (the monthly-average denominator)
  totalLabor: number;
  totalSales: number;
  avgLaborPerDay: number;  // totalLabor / dayCount — the "ค่าเฉลี่ยทั้งเดือน"
  avgColPct: number | null;// totalLabor / totalSales × 100
};

/** Company-wide daily labour cost (actual clocked hours × each staff's stored
 *  rate) for a month, plus the monthly per-day average. Mirrors getDailyColRows'
 *  rate model (PT: hours × hourly_rate; FT: hours × monthly_salary/22/8). COL%
 *  is against the SALESA daily nett so it matches the rest of the ANALYTICA
 *  page. Current month → through today; a past month → the full month. */
export function companyMonthLabor(
  companyBranchIds: number[], year: number, month: number, todayBkk: string
): CompanyMonthLabor {
  const empty: CompanyMonthLabor = { days: [], dayCount: 0, totalLabor: 0, totalSales: 0, avgLaborPerDay: 0, avgColPct: null };
  if (companyBranchIds.length === 0) return empty;

  const mm = String(month).padStart(2, "0");
  const first = `${year}-${mm}-01`;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthEnd = `${year}-${mm}-${String(daysInMonth).padStart(2, "0")}`;
  const isCurrent = year === Number(todayBkk.slice(0, 4)) && month === Number(todayBkk.slice(5, 7));
  const end = isCurrent ? (todayBkk < monthEnd ? todayBkk : monthEnd) : monthEnd;
  if (end < first) return empty;

  // Date list first..end (noon-UTC anchored so day math never slips timezones).
  const dates: string[] = [];
  for (let t = new Date(`${first}T12:00:00Z`).getTime(); ; t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (d > end) break;
    dates.push(d);
  }

  const db = getDb();
  const bph = companyBranchIds.map(() => "?").join(",");
  const startIso = new Date(`${first}T00:00:00+07:00`).toISOString();
  const endIso = new Date(`${end}T23:59:59+07:00`).toISOString();
  const entries = db.prepare(
    `SELECT user_id, ts, type FROM time_entries
     WHERE branch_id IN (${bph}) AND ts >= ? AND ts <= ? ORDER BY ts ASC`
  ).all(...companyBranchIds, startIso, endIso) as Array<{ user_id: number; ts: string; type: "in" | "out" }>;

  const laborByDay = laborCostByDay(db, computeWorkedMinutesByDay(entries));

  // Company POS nett per date — has_sales = 1 to match every other salesa_daily
  // aggregation on this page (a menu-only import is not counted as sales).
  const salesByDate = new Map(
    (db.prepare(
      `SELECT sale_date AS date, SUM(nett) AS nett FROM salesa_daily
       WHERE branch_id IN (${bph}) AND has_sales = 1 AND sale_date >= ? AND sale_date <= ? GROUP BY sale_date`
    ).all(...companyBranchIds, first, end) as Array<{ date: string; nett: number }>).map((r) => [r.date, r.nett])
  );

  // totalLabor spans every elapsed day; the COL% ratio compares labour and
  // sales over the SAME days (those with recorded sales), so a day whose POS
  // sales aren't imported yet doesn't inflate the %.
  let totalLabor = 0, totalSales = 0, laborOnSalesDays = 0;
  const days: CompanyLaborDay[] = dates.map((date) => {
    const laborCost = laborByDay.get(date) ?? 0;
    const salesNett = salesByDate.has(date) ? Math.round(salesByDate.get(date)! * 100) / 100 : null;
    const colPct = salesNett && salesNett > 0 ? Math.round((laborCost / salesNett) * 1000) / 10 : null;
    totalLabor += laborCost;
    if (salesNett != null && salesNett > 0) { totalSales += salesNett; laborOnSalesDays += laborCost; }
    return { date, laborCost, salesNett, colPct };
  });

  totalLabor = Math.round(totalLabor * 100) / 100;
  totalSales = Math.round(totalSales * 100) / 100;
  const dayCount = dates.length;
  return {
    days, dayCount, totalLabor, totalSales,
    avgLaborPerDay: dayCount > 0 ? Math.round((totalLabor / dayCount) * 100) / 100 : 0,
    avgColPct: totalSales > 0 ? Math.round((laborOnSalesDays / totalSales) * 1000) / 10 : null
  };
}
