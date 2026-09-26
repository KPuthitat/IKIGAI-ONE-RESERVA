// Backdated OT requests (owner 2026-09-26): a staffer files an OT request for a
// PAST day — early-start and/or late-end — but ONLY for a day that falls inside
// a payroll period that is still OPEN (status = 'draft'), so an already
// finalized/paid period can never be reopened. The request lands in the SAME
// ot_requests table + approval flow as the clock-out OT, and the pay engine
// credits it once a supervisor approves and the period is recomputed.

import type Database from "better-sqlite3";
import {
  effectiveShiftStartForUserDate,
  scheduledShiftEndForUserDate,
  actualWorkedMinutesForUserDate,
  userAssignmentDatesInRange,
} from "@/lib/roster";

export type OpenPeriod = { id: number; period_start: string; period_end: string };

function normEmp(employmentType: string | null | undefined): "ft" | "pt" {
  return employmentType === "ft" ? "ft" : "pt";
}

/** The OPEN (draft) payroll period that applies to this user and CONTAINS
 *  `workDate`, or null. A period applies when its branch matches the user's
 *  branch (or is NULL = company-wide FT / legacy all-branches) AND its target
 *  covers the user's employment_type. Prefers a branch-specific period over a
 *  NULL-branch one. */
export function openPeriodForUserDate(
  db: Database.Database,
  args: { branchId: number | null; employmentType: string | null; workDate: string }
): OpenPeriod | null {
  const et = normEmp(args.employmentType);
  const row = db.prepare(`
    SELECT id, period_start, period_end FROM payroll_periods
    WHERE status = 'draft'
      AND period_start <= ? AND period_end >= ?
      AND (branch_id IS NULL OR branch_id = ?)
      AND (target = 'all' OR target = ?)
    ORDER BY (branch_id IS NOT NULL) DESC, period_start DESC
    LIMIT 1
  `).get(args.workDate, args.workDate, args.branchId, et) as OpenPeriod | undefined;
  return row ?? null;
}

/** All OPEN (draft) periods that apply to this user (branch + target), newest
 *  first — the page unions their eligible days. Periods normally don't overlap. */
export function openPeriodsForUser(
  db: Database.Database,
  args: { branchId: number | null; employmentType: string | null }
): OpenPeriod[] {
  const et = normEmp(args.employmentType);
  return db.prepare(`
    SELECT id, period_start, period_end FROM payroll_periods
    WHERE status = 'draft'
      AND (branch_id IS NULL OR branch_id = ?)
      AND (target = 'all' OR target = ?)
    ORDER BY period_start DESC
  `).all(args.branchId, et) as OpenPeriod[];
}

export type BackdateDay = {
  date: string;                     // YYYY-MM-DD (BKK)
  scheduledStart: string | null;    // HH:MM
  scheduledEnd: string | null;      // HH:MM
  actualIn: string | null;          // HH:MM — first clock-in (prefill early)
  actualOut: string | null;         // HH:MM — last clock-out (prefill late)
  workedMinutes: number;            // actual paired minutes (attendance proof)
  status: string | null;            // existing ot_requests.status (late segment)
  earlyStatus: string | null;       // existing ot_requests.early_status
  requestedUntil: string | null;
  requestedFrom: string | null;
};

/** First clock-in / last clock-out (BKK HH:MM) for a user on a date, or nulls. */
function punchBoundsForDate(db: Database.Database, branchId: number, userId: number, dateBkk: string): { in: string | null; out: string | null } {
  const dayStart = new Date(`${dateBkk}T00:00:00+07:00`).toISOString();
  const dayEnd = new Date(`${dateBkk}T23:59:59+07:00`).toISOString();
  const row = db.prepare(
    `SELECT MIN(CASE WHEN type='in' THEN ts END) AS tin, MAX(CASE WHEN type='out' THEN ts END) AS tout
       FROM time_entries WHERE branch_id=? AND user_id=? AND ts>=? AND ts<=?`
  ).get(branchId, userId, dayStart, dayEnd) as { tin: string | null; tout: string | null };
  const toHHMM = (iso: string | null) => {
    if (!iso) return null;
    const d = new Date(new Date(iso).getTime() + 7 * 3600_000);
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  };
  return { in: toHHMM(row.tin), out: toHHMM(row.tout) };
}

/** The days a user may file backdated OT for: assigned days that were actually
 *  worked, inside the open period, strictly BEFORE today (today's OT is filed at
 *  clock-out). Newest first. Each carries the scheduled shift + any existing OT
 *  request so the form can prefill and show status. */
export function eligibleBackdateDays(
  db: Database.Database,
  args: { userId: number; branchId: number; period: OpenPeriod; todayBkk: string }
): BackdateDay[] {
  const from = args.period.period_start;
  // Backdated = strictly before today; also never past the period end.
  const to = args.period.period_end < args.todayBkk ? args.period.period_end : prevDay(args.todayBkk);
  if (to < from) return [];

  const dates = userAssignmentDatesInRange(args.branchId, args.userId, from, to);
  const otByDate = new Map<string, { status: string | null; early_status: string | null; requested_until: string | null; requested_from: string | null }>();
  for (const r of db.prepare(
    `SELECT work_date, status, early_status, requested_until, requested_from
       FROM ot_requests WHERE user_id = ? AND work_date >= ? AND work_date <= ?`
  ).all(args.userId, from, to) as Array<{ work_date: string; status: string | null; early_status: string | null; requested_until: string | null; requested_from: string | null }>) {
    otByDate.set(r.work_date, r);
  }

  const out: BackdateDay[] = [];
  for (const date of dates) {
    const workedMinutes = actualWorkedMinutesForUserDate(args.branchId, args.userId, date);
    if (workedMinutes <= 0) continue;   // only days actually worked (OT needs a real shift)
    const ot = otByDate.get(date);
    const punches = punchBoundsForDate(db, args.branchId, args.userId, date);
    out.push({
      date,
      scheduledStart: effectiveShiftStartForUserDate(args.userId, args.branchId, date),
      scheduledEnd: scheduledShiftEndForUserDate(args.userId, args.branchId, date),
      actualIn: punches.in,
      actualOut: punches.out,
      workedMinutes,
      status: ot?.status ?? null,
      earlyStatus: ot?.early_status ?? null,
      requestedUntil: ot?.requested_until ?? null,
      requestedFrom: ot?.requested_from ?? null,
    });
  }
  out.reverse();   // newest first
  return out;
}

function prevDay(dateBkk: string): string {
  const d = new Date(`${dateBkk}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
