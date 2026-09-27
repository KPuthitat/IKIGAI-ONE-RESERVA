import { getDb } from "@/lib/db";

// Daily Cost-of-Labour (%COL) for the management dashboard (owner 2026-06-13).
// Labour cost is costed from the ROSTERED plan (roster_assignments × shift_codes),
// NOT clocked hours (owner 2026-09-27): staff who don't clock in (salaried /
// managers) still count, and each day's cost reflects the shift booked that day.
//   • FT (ประจำ): monthly_salary / 30 per rostered working day — independent of
//     shift length (a paid rest-day-inclusive daily wage; the old "/8 hours" is
//     gone, since dividing by that day's shift hours and multiplying back cancels).
//   • PT (พาร์ทไทม์): that day's rostered shift hours × hourly_rate.
// COL% = labour cost / that day's recorded sales.

export type DailyColRow = {
  date: string; // YYYY-MM-DD (Bangkok)
  revenue: number | null; // recorded daily sales, null when not entered
  laborCost: number; // baht, from the rostered plan × rate
  colPct: number | null; // laborCost / revenue × 100, null when no revenue
};

const HHMM = /^\d{2}:\d{2}$/;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** Worked hours of one shift (end − start − break); handles an overnight shift.
 *  A zero-length shift (start == end) is 0, not 24h. */
function shiftHours(start: string, end: string, bs: string | null, be: string | null): number {
  if (!HHMM.test(start) || !HHMM.test(end)) return 0;
  let s = toMin(start), e = toMin(end);
  if (e < s) e += 1440;                         // overnight (e.g. 22:00→02:00); e==s → 0
  let mins = e - s;
  if (bs && be && HHMM.test(bs) && HHMM.test(be)) {
    let bStart = toMin(bs), bEnd = toMin(be);
    if (bEnd < bStart) bEnd += 1440;            // break that spans midnight
    const b = bEnd - bStart;
    if (b > 0) mins -= b;
  }
  return mins > 0 ? mins / 60 : 0;
}

export type RosterCostDay = { cost: number; headcount: number; ftCount: number; ptCount: number };

/** Per-day roster labour cost + headcount for a set of branches over an inclusive
 *  date range — the single rate model shared by the today snapshot, the branch
 *  daily view and the company monthly view. Real staff only (no disabled/
 *  resigned/test). A user holding two shifts in a day is counted once (FT: one
 *  daily share; PT: summed shift hours). */
function rosterCostByDay(
  db: ReturnType<typeof getDb>, branchIds: number[], startDate: string, endDate: string
): Map<string, RosterCostDay> {
  const out = new Map<string, RosterCostDay>();
  if (branchIds.length === 0) return out;
  const ph = branchIds.map(() => "?").join(",");
  const rows = db.prepare(
    // kind='work' skips day-off codes; a staffer on approved leave that day is
    // excluded (they aren't working) — mirrors ascenda-engine's roster costing.
    `SELECT ra.assignment_date date, ra.user_id uid, u.employment_type type,
            u.hourly_rate hourly, u.monthly_salary monthly,
            sc.start_time st, sc.end_time et, sc.break_start bs, sc.break_end be
       FROM roster_assignments ra
       JOIN shift_codes sc ON sc.id = ra.shift_code_id
       JOIN users u ON u.id = ra.user_id
      WHERE ra.branch_id IN (${ph}) AND ra.assignment_date >= ? AND ra.assignment_date <= ?
        AND sc.kind = 'work'
        AND u.status NOT IN ('disabled','resigned') AND COALESCE(u.is_test_account,0) = 0
        AND NOT EXISTS (
          SELECT 1 FROM leave_requests lr
           WHERE lr.user_id = ra.user_id AND lr.status = 'approved'
             AND lr.date_from <= ra.assignment_date AND lr.date_to >= ra.assignment_date
        )`
  ).all(...branchIds, startDate, endDate) as Array<{
    date: string; uid: number; type: string | null; hourly: number | null; monthly: number | null;
    st: string; et: string; bs: string | null; be: string | null;
  }>;
  // Aggregate per (date, user): a user may hold more than one shift a day.
  const perDay = new Map<string, Map<number, { type: string | null; hourly: number | null; monthly: number | null; hours: number }>>();
  for (const r of rows) {
    const dm = perDay.get(r.date) ?? new Map<number, { type: string | null; hourly: number | null; monthly: number | null; hours: number }>();
    const u = dm.get(r.uid) ?? { type: r.type, hourly: r.hourly, monthly: r.monthly, hours: 0 };
    u.hours += shiftHours(r.st, r.et, r.bs, r.be);
    dm.set(r.uid, u); perDay.set(r.date, dm);
  }
  for (const [date, dm] of perDay) {
    let cost = 0, headcount = 0, ftCount = 0, ptCount = 0;
    for (const u of dm.values()) {
      headcount++;
      if (u.type === "ft" && u.monthly) { cost += u.monthly / 30; ftCount++; }
      else if (u.type === "pt" && u.hourly) { cost += u.hours * u.hourly; ptCount++; }
    }
    out.set(date, { cost: Math.round(cost * 100) / 100, headcount, ftCount, ptCount });
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
  const laborByDay = rosterCostByDay(db, [branchId], oldest, todayBkk);

  // Recorded sales per date.
  const revRows = db
    .prepare(
      `SELECT date, revenue FROM branch_daily_revenue
       WHERE branch_id = ? AND date >= ? AND date <= ?`
    )
    .all(branchId, oldest, todayBkk) as Array<{ date: string; revenue: number }>;
  const revByDate = new Map(revRows.map((r) => [r.date, r.revenue]));

  return dates.map((date) => {
    const laborCost = laborByDay.get(date)?.cost ?? 0;
    const revenue = revByDate.has(date) ? revByDate.get(date)! : null;
    const colPct =
      revenue && revenue > 0 ? Math.round((laborCost / revenue) * 1000) / 10 : null;
    return { date, revenue, laborCost, colPct };
  });
}

// ── ANALYTICA: today's COL snapshot for one branch (owner 2026-09-26) ────────
// "วันนี้มีพนักงานกี่คน (ประจำ/พาร์ทไทม์), เป็นต้นทุนแรงงานกี่บาท, กี่ % ของยอดขาย
// วันนี้." Headcount + cost come from today's ROSTER (owner 2026-09-27), so staff
// who don't clock are included and the cost is the full booked shift — the same
// roster model as getDailyColRows / companyMonthLabor.

export type TodayCol = {
  date: string;             // Bangkok YYYY-MM-DD
  headcount: number;        // distinct real staff rostered today
  ftCount: number;          // of those, full-time
  ptCount: number;          // of those, part-time
  otherCount: number;       // of those, neither (contract/unset) — so the split reconciles
  laborCost: number;        // baht — rostered shift × rate (FT salary/30, PT hours × rate)
  salesNett: number | null; // this branch's POS nett today
  colPct: number | null;    // laborCost / salesNett × 100
};

export function branchTodayCol(branchId: number, todayBkk: string): TodayCol {
  const db = getDb();
  // Roster-based (owner 2026-09-27): everyone booked on today's roster counts —
  // including staff who don't clock — and the cost is the full booked shift, not
  // pro-rated to "now". FT = salary/30/day, PT = shift hours × rate.
  const r = rosterCostByDay(db, [branchId], todayBkk, todayBkk).get(todayBkk)
    ?? { cost: 0, headcount: 0, ftCount: 0, ptCount: 0 };
  const laborCost = r.cost, headcount = r.headcount, ftCount = r.ftCount, ptCount = r.ptCount;

  const salesRow = db.prepare(
    `SELECT SUM(nett) AS nett FROM salesa_daily WHERE branch_id = ? AND has_sales = 1 AND sale_date = ?`
  ).get(branchId, todayBkk) as { nett: number | null } | undefined;
  // A clinic branch's revenue is in clinica_bills, so add it to the COL denominator
  // (owner 2026-09-27) — otherwise COL% reads "—" for a clinic that has revenue.
  const cliRow = db.prepare(
    `SELECT COALESCE(SUM(net),0) AS net FROM clinica_bills WHERE branch_id = ? AND bill_date = ?`
  ).get(branchId, todayBkk) as { net: number };
  // Keep the original shape for a restaurant (a recorded POS row stays numeric,
  // even 0/negative); a clinic-only day surfaces once its bills sum non-zero.
  const salesNett = (salesRow?.nett != null || cliRow.net !== 0)
    ? Math.round(((salesRow?.nett ?? 0) + cliRow.net) * 100) / 100
    : null;
  const colPct = salesNett && salesNett > 0 ? Math.round((laborCost / salesNett) * 1000) / 10 : null;

  return { date: todayBkk, headcount, ftCount, ptCount, otherCount: headcount - ftCount - ptCount, laborCost, salesNett, colPct };
}

// ── ANALYTICA: company-wide daily labour cost for a month (owner 2026-09-24) ──

export type CompanyLaborDay = {
  date: string;            // YYYY-MM-DD (Bangkok)
  laborCost: number;       // baht — rostered plan × each staff's rate
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

/** Company-wide daily labour cost (rostered plan × each staff's stored rate) for
 *  a month, plus the monthly per-day average. Mirrors getDailyColRows'
 *  roster model (PT: shift hours × hourly_rate; FT: monthly_salary/30 per day).
 *  COL% is against the SALESA daily nett so it matches the rest of the ANALYTICA
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
  const laborByDay = rosterCostByDay(db, companyBranchIds, first, end);

  // Company POS nett per date — has_sales = 1 to match every other salesa_daily
  // aggregation on this page (a menu-only import is not counted as sales).
  const salesByDate = new Map(
    (db.prepare(
      `SELECT sale_date AS date, SUM(nett) AS nett FROM salesa_daily
       WHERE branch_id IN (${bph}) AND has_sales = 1 AND sale_date >= ? AND sale_date <= ? GROUP BY sale_date`
    ).all(...companyBranchIds, first, end) as Array<{ date: string; nett: number }>).map((r) => [r.date, r.nett] as [string, number])
  );
  // Fold clinic branches' billed net per date (owner 2026-09-27) so a hybrid
  // company's COL% denominator isn't understated.
  for (const r of db.prepare(
    `SELECT bill_date AS date, SUM(net) AS net FROM clinica_bills
       WHERE branch_id IN (${bph}) AND bill_date <> '' AND bill_date >= ? AND bill_date <= ? GROUP BY bill_date`
  ).all(...companyBranchIds, first, end) as Array<{ date: string; net: number }>) {
    salesByDate.set(r.date, (salesByDate.get(r.date) ?? 0) + r.net);
  }

  // totalLabor spans every elapsed day; the COL% ratio compares labour and
  // sales over the SAME days (those with recorded sales), so a day whose POS
  // sales aren't imported yet doesn't inflate the %.
  let totalLabor = 0, totalSales = 0, laborOnSalesDays = 0;
  const days: CompanyLaborDay[] = dates.map((date) => {
    const laborCost = laborByDay.get(date)?.cost ?? 0;
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
