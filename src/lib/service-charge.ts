// Service Charge (SVC) — daily collection + monthly distribution.
//
// Business rules per the owner's 2026-05-13 spec:
//   1. Pool source: admin / closing-shift staff logs the daily POS
//      SVC amount via daily_service_charge (one row per branch per
//      day). Audit columns capture entered_by + updated_by.
//   2. Distribution: split 5 ways — 3 parts to staff (60%), 2 parts
//      to the company (40%). The 60% pool is then divided
//      PROPORTIONALLY among staff who worked that day, weighted by
//      paired (in→out) shift minutes that day.
//   3. Forfeiture (monthly): if a staff's monthly late minutes
//      exceed SC_INELIGIBILITY_THRESHOLD (20%, from late-detection)
//      OR their resignation_request for the period was approved
//      with forfeit_svc=1, their entire month's SVC accrual flips
//      to the company pool.
//   4. Payout date: 20th of the following month (UI-only — the
//      number is computed for display; payout itself is up to the
//      payroll workflow / bank CSV).
//
// All amounts are THB, kept as floats — the daily inputs come from
// POS reports that already include satang in the totals, and the
// pool can be a non-round number after the 60/40 split. The UI
// presents whole baht via toFixed(2) so users see "240.00 / 480.00"
// not "240/480".

import { getDb } from "./db";
import { pairShifts, applyPtGrace, pickScheduled, deductBreak, type ScheduledShift, type PayrollSettings } from "./payroll-compute";
import { nameWithPrefix } from "./name";
import { approvedEarlyLeaveKeys } from "./early-leave";
import { LATE_GRACE_MINUTES, SC_INELIGIBILITY_THRESHOLD } from "./late-detection";
import {
  shiftStartByDateForUserMonth,
  scheduledMinutesByUserForMonth
} from "./roster";

export const SVC_STAFF_SHARE_RATIO = 0.6;  // 3 of 5 parts
export const SVC_COMPANY_SHARE_RATIO = 0.4; // 2 of 5 parts

// Maximum worked minutes a normal day can contribute to the SVC share
// (owner 2026-07-21): 8 hours = 480 min. A day can only exceed this with an
// approved OT record (ot_requests) — otherwise the day is capped at 480 even if
// the clocked/rostered window was longer. Effective July 2026 onward.
export const SVC_MAX_NORMAL_MINUTES = 8 * 60;

// Food-credit clawback threshold (owner 2026-07-30): a staffer who redeemed the
// free lunch but whose actual clamped worked minutes fall below 480 − a 30-min
// grace (= 450) is treated as having left the ≥8h shift early. Without an
// approved early-leave for that day, the day's food credit is clawed back from
// their SVC share. The grace absorbs a slightly-short punch on a full shift.
export const FOOD_CLAWBACK_GRACE_MINUTES = 30;
export const FOOD_CLAWBACK_MIN_MINUTES = SVC_MAX_NORMAL_MINUTES - FOOD_CLAWBACK_GRACE_MINUTES;

/** Pure clawback decision (owner 2026-07-30) — extracted for testability. Given
 *  the month's redeemed food coupons (user, date, credit), the per-day clamped
 *  worked minutes, the set of "userId:date" approved early-leaves, and a roster
 *  predicate, returns the clawback days per user. A day is clawed back only when
 *  it is on this branch's SVC roster, HAS a measurable minutes figure below the
 *  threshold, and is NOT covered by an approved early-leave. Days with no
 *  measurable minutes (abnormal/uncertified → already SVC-excluded) are skipped
 *  so we never double-penalise or penalise missing data. */
export function computeFoodClawbacks(
  redeemedFood: Array<{ uid: number; d: string; credit: number }>,
  workedByDay: Map<string, Map<number, number>>,
  approvedEarlyLeave: Set<string>,
  isRosterMember: (uid: number) => boolean,
  minMinutes: number = FOOD_CLAWBACK_MIN_MINUTES
): Map<number, Array<{ date: string; credit: number }>> {
  const out = new Map<number, Array<{ date: string; credit: number }>>();
  for (const c of redeemedFood) {
    if (!isRosterMember(c.uid)) continue;
    const worked = workedByDay.get(c.d)?.get(c.uid);
    if (worked == null) continue;
    if (worked >= minMinutes) continue;
    if (approvedEarlyLeave.has(`${c.uid}:${c.d}`)) continue;
    let arr = out.get(c.uid);
    if (!arr) { arr = []; out.set(c.uid, arr); }
    arr.push({ date: c.d, credit: c.credit });
  }
  return out;
}

// ── Group insurance (ประกันกลุ่ม) — owner 2026-08-02 ────────────────
// The group-insurance premium of ฿350/month is withheld from an employee's
// SERVICE CHARGE (not wages) for a fixed enrolment window:
//   • Full-time (ft): 3 calendar months
//   • Part-time (pt): 12 calendar months
// The window counts from a MANUALLY CHOSEN start month (group_insurance_start_
// month, YYYY-MM) — NOT the hire date — because the owner doesn't always enrol a
// new hire on day one; they wait for a cycle (owner 2026-08-02: "ให้เลือกเองว่า
// เริ่มจ่ายเดือนไหน หลังจากนั้นออโต้"). The start month = month 0. NULL start month
// means not enrolled yet → nothing is withheld until the owner sets it. Withheld
// once per month — the SVC payout is itself monthly, so one deduction per person
// per month falls out naturally.
export const GROUP_INSURANCE_MONTHLY = 350;
export const GROUP_INSURANCE_MONTHS_FT = 3;
export const GROUP_INSURANCE_MONTHS_PT = 12;

/** Calendar months between two YYYY-MM strings (0 = same month, so the start
 *  month itself counts as month 0). Both are sliced to YYYY-MM so a full date
 *  works too. */
export function calendarMonthsBetween(fromMonth: string, toMonth: string): number {
  const [fy, fm] = fromMonth.slice(0, 7).split("-").map(Number);
  const [ty, tm] = toMonth.slice(0, 7).split("-").map(Number);
  return (ty * 12 + tm) - (fy * 12 + fm);
}

/** Pure group-insurance decision — the ฿ to withhold from ONE person's SVC for
 *  `yearMonth`. Returns 0 when not enrolled (no start month), employment type
 *  unknown, before the start month, or the window has passed. `availablePayout`
 *  (the SVC left after forfeit + WHT) caps the amount so a payout never goes
 *  negative. */
export function groupInsuranceDeduction(args: {
  employmentType: string | null;
  startMonth: string | null;   // YYYY-MM chosen by the owner; null = not enrolled → 0
  yearMonth: string;
  availablePayout: number;
}): number {
  const { employmentType, startMonth, yearMonth, availablePayout } = args;
  if (!startMonth || availablePayout <= 0) return 0;
  const window = employmentType === "pt" ? GROUP_INSURANCE_MONTHS_PT
    : employmentType === "ft" ? GROUP_INSURANCE_MONTHS_FT
    : 0;
  if (window === 0) return 0; // unknown employment type → don't guess
  const elapsed = calendarMonthsBetween(startMonth, yearMonth);
  if (elapsed < 0 || elapsed >= window) return 0; // before start / window passed
  return Math.min(GROUP_INSURANCE_MONTHLY, Math.round(availablePayout * 100) / 100);
}

// The month this system started recording SVC from live clock/roster data
// (owner 2026-07-21). Months BEFORE this are pre-system: no time entries to
// distribute a pool over, so the per-staff SVC is entered by hand
// (svc_manual_allocations) instead of computed. This month and later use the
// normal time-entry engine.
export const SVC_SYSTEM_START_MONTH = "2026-06";

/** A YYYY-MM month is "manual entry" (typed by hand) when it predates the
 *  system going live. String compare is safe on zero-padded YYYY-MM. */
export function isManualSvcMonth(yearMonth: string): boolean {
  return yearMonth < SVC_SYSTEM_START_MONTH;
}

/** Read the hand-entered GROSS SVC amount per user for a manual month.
 *  Keyed by user_id; absent users default to 0 at the call site. */
export function listManualAllocations(
  branchId: number,
  yearMonth: string
): Map<number, number> {
  const rows = getDb().prepare(
    "SELECT user_id, gross_amount FROM svc_manual_allocations WHERE branch_id = ? AND year_month = ?"
  ).all(branchId, yearMonth) as Array<{ user_id: number; gross_amount: number }>;
  const m = new Map<number, number>();
  for (const r of rows) m.set(r.user_id, r.gross_amount);
  return m;
}

/** Upsert the hand-entered GROSS SVC amounts for a manual month, one row per
 *  user (owner 2026-07-21). Audit columns capture the first entry vs edits.
 *  Runs in a single transaction so a bad row rolls the whole save back. */
export function saveManualAllocations(args: {
  branchId: number;
  yearMonth: string;
  allocations: Array<{ userId: number; gross: number }>;
  userId: number;
}): number {
  const db = getDb();
  const nowIso = new Date().toISOString();
  const up = db.prepare(`
    INSERT INTO svc_manual_allocations
      (branch_id, year_month, user_id, gross_amount, entered_by_user_id, entered_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(branch_id, year_month, user_id) DO UPDATE SET
      gross_amount = excluded.gross_amount,
      updated_by_user_id = ?,
      updated_at = ?
  `);
  const run = db.transaction(() => {
    let n = 0;
    for (const a of args.allocations) {
      up.run(args.branchId, args.yearMonth, a.userId, a.gross,
        args.userId, nowIso, args.userId, nowIso);
      n++;
    }
    return n;
  });
  return run();
}

export type DailySvcRow = {
  id: number;
  branch_id: number;
  date: string;             // YYYY-MM-DD
  amount_baht: number;
  entered_by_user_id: number;
  entered_at: string;       // ISO
  updated_by_user_id: number | null;
  updated_at: string | null;
  daily_report_id: number | null;
};

export type DailySvcRowWithUsers = DailySvcRow & {
  entered_by_name: string;
  updated_by_name: string | null;
};

/** Per-staff per-day allocation row before forfeiture is applied. */
export type DailyAllocation = {
  userId: number;
  displayName: string;
  date: string;             // YYYY-MM-DD
  minutesWorked: number;    // sum of paired-shift durations that day
  allocation: number;       // THB share of staff pool that day
};

/** Per-staff monthly roll-up — sums daily allocations + applies
 *  monthly forfeiture rules. */
export type MonthlySvcRow = {
  userId: number;
  displayName: string;
  employmentType: string | null;
  shiftStartTime: string | null;
  // Worked
  totalMinutesWorked: number;
  daysWorked: number;
  scheduledMinutes: number;  // for ratio denominator
  lateMinutes: number;
  lateRatio: number;
  // Money
  grossAllocation: number;   // pre-forfeit accrual from daily splits
  forfeited: boolean;
  forfeitReason: "late_20pct" | "resignation" | null;
  // Executive override (owner 2026-08-20): when set, the automatic forfeiture was
  // WAIVED for this person this month — forfeited flips back to false and they are
  // paid. exemptReason records what was waived (for the "ยกเว้นให้ · เดิม: …" badge).
  exempted: boolean;
  exemptReason: "late_20pct" | "resignation" | null;
  netAllocation: number;     // 0 if forfeited; else grossAllocation (pre-WHT)
  // Withholding tax on the SVC payout, mirroring payroll (owner 2026-07-21):
  // 'wht' staff have 3% withheld, 'sso' staff receive the full net.
  taxMode: "sso" | "wht";
  whtAmount: number;         // netAllocation × wht_rate when taxMode==='wht', else 0
  // Group-insurance premium withheld from this month's SVC (owner 2026-08-02).
  // 0 outside the new-hire window (FT 3mo / PT 12mo) or when hire_date unknown.
  groupInsurance: number;
  netPayout: number;         // netAllocation − whtAmount − groupInsurance (actually paid)
  // แจกแจงรายวันว่าส่วนแบ่งมาจากไหน (owner 2026-07-20 — ปุ่ม "วิธีคำนวณ").
  // share = dayAmount × 60% × (userMinutes ÷ totalMinutes). ผลรวม share = grossAllocation.
  dailyBreakdown: Array<{
    date: string; dayAmount: number; staffPool: number;
    userMinutes: number; totalMinutes: number; share: number;
  }>;
  // วันที่ถูกตัดสิทธิ์เพราะเวลางานผิดปกติ/ไม่รับรองเวลา (owner 2026-07-21) —
  // แสดงในตารางวิธีคำนวณเพื่อความโปร่งใส. ว่างเสมอสำหรับเดือนก่อนกฎมีผล (มิ.ย.).
  excludedDays: Array<{ date: string; reason: string }>;
  // Food-credit clawback (owner 2026-07-30): ฿ recovered from this person's SVC
  // because they redeemed the free lunch but left the ≥8h shift early (worked <
  // 480−30min) without an approved early-leave. Reduces netAllocation; the
  // recovered amount goes to the company pool. Empty when the feature doesn't
  // apply (no redemption / stayed full / approved).
  foodClawback: number;
  foodClawbackDays: Array<{ date: string; credit: number }>;
};

export type MonthlySvcSummary = {
  branchId: number;
  yearMonth: string;         // YYYY-MM
  totalCollected: number;    // sum of daily amount_baht
  staffPoolTotal: number;    // 60% of totalCollected
  companyPoolFromSplit: number; // 40% (always)
  companyPoolFromForfeit: number; // additional from forfeitures
  companyPoolFromClawback: number; // additional from food-credit clawbacks (owner 2026-07-30)
  companyPoolTotal: number;  // sum of the three above
  totalWht: number;          // sum of per-staff WHT withheld from SVC
  // Group-insurance premiums withheld from staff SVC this month (owner
  // 2026-08-02) — held as a payable to remit to the insurer, NOT company income.
  totalGroupInsurance: number;
  totalNetPayout: number;    // sum of per-staff netPayout (after forfeit + WHT + group insurance)
  rows: MonthlySvcRow[];
  daysWithEntries: number;   // for UX: how many days admin has filled
  daysInMonth: number;
  payoutDate: string;        // YYYY-MM-20 of the following month
  // Manual-entry month (owner 2026-07-21): months before the system went live
  // (< SVC_SYSTEM_START_MONTH) have no clock/roster data, so the per-staff gross
  // is TYPED by hand (svc_manual_allocations) instead of computed. When true the
  // page shows the editable entry table and hides the daily-ledger / hours cols.
  manualEntry: boolean;
};

// ── DB helpers ───────────────────────────────────────────────────

/** Upsert a daily SVC row. Returns the row id. If a row already
 *  exists for (branch_id, date) we UPDATE instead — admin can correct
 *  amounts after the fact, and updated_by/updated_at capture who. */
export function upsertDailyServiceCharge(args: {
  branchId: number;
  date: string;
  amountBaht: number;
  userId: number;
  dailyReportId?: number | null;
}): { id: number; created: boolean } {
  const db = getDb();
  const nowIso = new Date().toISOString();
  const existing = db.prepare(
    "SELECT id FROM daily_service_charge WHERE branch_id = ? AND date = ?"
  ).get(args.branchId, args.date) as { id: number } | undefined;
  if (existing) {
    db.prepare(`
      UPDATE daily_service_charge
      SET amount_baht = ?, updated_by_user_id = ?, updated_at = ?,
          daily_report_id = COALESCE(?, daily_report_id)
      WHERE id = ?
    `).run(
      args.amountBaht, args.userId, nowIso,
      args.dailyReportId ?? null, existing.id
    );
    return { id: existing.id, created: false };
  }
  const info = db.prepare(`
    INSERT INTO daily_service_charge
      (branch_id, date, amount_baht, entered_by_user_id, entered_at, daily_report_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    args.branchId, args.date, args.amountBaht,
    args.userId, nowIso, args.dailyReportId ?? null
  );
  return { id: Number(info.lastInsertRowid), created: true };
}

/** Fetch all daily SVC rows for a branch within a YYYY-MM-prefixed
 *  date range. Returned ordered by date ASC so callers can iterate
 *  in calendar order without re-sorting. */
export function listDailyForMonth(
  branchId: number,
  yearMonth: string
): DailySvcRowWithUsers[] {
  const start = `${yearMonth}-01`;
  const end = `${yearMonth}-31`; // SQLite text compare is fine on YYYY-MM-DD
  return getDb().prepare(`
    SELECT dsc.*,
           u1.display_name AS entered_by_name,
           u2.display_name AS updated_by_name
    FROM daily_service_charge dsc
    JOIN users u1 ON u1.id = dsc.entered_by_user_id
    LEFT JOIN users u2 ON u2.id = dsc.updated_by_user_id
    WHERE dsc.branch_id = ? AND dsc.date >= ? AND dsc.date <= ?
    ORDER BY dsc.date ASC
  `).all(branchId, start, end) as DailySvcRowWithUsers[];
}

// ── Compute helpers ──────────────────────────────────────────────

/** Bucket a stream of time_entries by YYYY-MM-DD (Bangkok local) of
 *  the clock-in event. Out-only rows are dropped because we only
 *  attribute hours to the day the staff started; an "in" at 23:00
 *  paired with "out" at 02:00 still counts as the earlier day. */
function bucketEntriesByDay(
  entries: Array<{ user_id: number; ts: string; type: "in" | "out" }>
): Map<string, Array<{ user_id: number; ts: string; type: "in" | "out" }>> {
  const out = new Map<string, Array<typeof entries[number]>>();
  for (const e of entries) {
    const bkk = new Date(new Date(e.ts).getTime() + 7 * 60 * 60 * 1000);
    const date = bkk.toISOString().slice(0, 10);
    if (!out.has(date)) out.set(date, []);
    out.get(date)!.push(e);
  }
  return out;
}

/** Compute per-staff worked-minutes-per-day from raw time_entries.
 *  Pairs ins → outs per (user, day) via pairShifts(). When the same
 *  staff has unmatched ins (e.g. forgot to clock out), those minutes
 *  are dropped — same conservative rule the payroll engine already
 *  follows. */
export function computeWorkedMinutesByDay(
  entries: Array<{ user_id: number; ts: string; type: "in" | "out" }>
): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  const byDay = bucketEntriesByDay(entries);
  for (const [date, dayEntries] of byDay) {
    // Group by user, pair shifts, sum minutes
    const byUser = new Map<number, Array<typeof entries[number]>>();
    for (const e of dayEntries) {
      if (!byUser.has(e.user_id)) byUser.set(e.user_id, []);
      byUser.get(e.user_id)!.push(e);
    }
    const userMin = new Map<number, number>();
    for (const [userId, list] of byUser) {
      const { shifts } = pairShifts(list);
      const total = shifts.reduce((s, x) => s + x.durationMinutes, 0);
      if (total > 0) userMin.set(userId, total);
    }
    out.set(date, userMin);
  }
  return out;
}

// YYYY-MM-DD + 1 calendar day (UTC-safe). Local copy of the payroll helper
// so the scheduled-window anchoring below matches payroll exactly.
function addDayYmd(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Build the per-(user, date) scheduled shift windows for a branch/month from
 *  the roster, mirroring the payroll engine (payroll-compute.ts ~1047). SVC
 *  minutes are then clamped to these windows so they match paid minutes. */
function buildScheduledByUser(
  branchId: number, start: string, end: string
): Map<number, Map<string, ScheduledShift[]>> {
  const rows = getDb().prepare(`
    SELECT ra.user_id, ra.assignment_date,
           sc.start_time, sc.end_time, sc.break_start, sc.break_end
    FROM roster_assignments ra
    JOIN shift_codes sc ON sc.id = ra.shift_code_id
    WHERE ra.branch_id = ? AND ra.assignment_date >= ? AND ra.assignment_date <= ?
      AND sc.kind = 'work'
  `).all(branchId, start, end) as Array<{
    user_id: number; assignment_date: string;
    start_time: string; end_time: string;
    break_start: string | null; break_end: string | null;
  }>;
  const byUser = new Map<number, Map<string, ScheduledShift[]>>();
  for (const r of rows) {
    if (!r.start_time || !r.end_time || r.start_time === r.end_time) continue;
    const startTs = new Date(`${r.assignment_date}T${r.start_time}:00+07:00`).toISOString();
    const endDate = r.end_time < r.start_time ? addDayYmd(r.assignment_date) : r.assignment_date;
    const endTs = new Date(`${endDate}T${r.end_time}:00+07:00`).toISOString();
    let breakStartTs: string | null = null;
    let breakEndTs: string | null = null;
    if (r.break_start && r.break_end && r.break_start !== r.break_end) {
      breakStartTs = new Date(`${r.assignment_date}T${r.break_start}:00+07:00`).toISOString();
      const bEndDate = r.break_end < r.break_start ? addDayYmd(r.assignment_date) : r.assignment_date;
      breakEndTs = new Date(`${bEndDate}T${r.break_end}:00+07:00`).toISOString();
    }
    let byDate = byUser.get(r.user_id);
    if (!byDate) { byDate = new Map(); byUser.set(r.user_id, byDate); }
    const list = byDate.get(r.assignment_date) ?? [];
    list.push({ startTs, endTs, breakStartTs, breakEndTs });
    byDate.set(r.assignment_date, list);
  }
  return byUser;
}

/** Net working minutes of a single scheduled shift window (gross − break) —
 *  used to credit execs (track_attendance=0, no clock) their full rostered
 *  shift length, e.g. NPF (11:00–21:00 − 14:00–16:00 break) = 480 min = 8h. */
function netScheduledMinutes(w: ScheduledShift): number {
  const gross = (new Date(w.endTs).getTime() - new Date(w.startTs).getTime()) / 60000;
  let brk = 0;
  if (w.breakStartTs && w.breakEndTs) {
    brk = (new Date(w.breakEndTs).getTime() - new Date(w.breakStartTs).getTime()) / 60000;
  }
  return Math.max(0, gross - brk);
}

type BreakSettings = Pick<PayrollSettings,
  "break_threshold_minutes" | "break_deduction_minutes" | "long_shift_threshold_minutes" | "long_shift_break_minutes">;

/** SVC worked-minutes per (date, user), CLAMPED to the rostered shift like
 *  payroll (owner 2026-07-21: นับเฉพาะเวลาตามกะ — มาก่อนเวลาเริ่มนับที่เวลากะ,
 *  หักเบรก). Reuses applyPtGrace/pickScheduled so SVC time matches the paid time
 *  in ค่าตอบแทน.
 *
 *  Break handling (owner 2026-07-21): when the shift has a scheduled break
 *  window, applyPtGrace already deducts it. When it does NOT — an unrostered
 *  clock-in, or a shift_code with no break defined — apply the same
 *  threshold-based break as payroll's deductBreak, so a long shift never counts
 *  the break as worked (a staffer who clocks in at the break start no longer
 *  collects the whole break as share).
 *
 *  Approved OT (owner 2026-07-21): when a day has an approved ot_requests row,
 *  the worked window may extend past the scheduled end up to the approved
 *  "requested_until" time — those extra minutes count toward SVC too, mirroring
 *  payroll's applyPtGrace(shift, sched, otUntilTs). */
function computeSvcClampedMinutesByDay(
  entries: Array<{ user_id: number; ts: string; type: "in" | "out" }>,
  scheduledByUser: Map<number, Map<string, ScheduledShift[]>>,
  otByUser: Map<number, Map<string, string>>,
  brk: BreakSettings,
  // owner 2026-07-21: exclude whole days with an irregular / uncertified punch
  // (forgot to clock in or out → system can't compute). Only ON for the months
  // this rule takes effect (ก.ค. เป็นต้นไป). When ON, such a day is dropped from
  // SVC entirely and recorded in excludedByUser with a reason for the breakdown.
  excludeAbnormal: boolean,
  // owner 2026-07-21 (July+): a clock-in on a day the user has NO scheduled shift
  // (สลับกะกันเอง / ลงเวลาในวันที่ไม่มีกะ) is abnormal — the day earns no SVC.
  // Separate gate from excludeAbnormal because it starts a month later.
  excludeNoSchedule: boolean,
  // owner 2026-08-02 ("ย้ายสาขาระหว่างวัน"): a legit mid-day branch transfer lands
  // an in/out pair at a branch the staff isn't rostered at. That must NOT be
  // dropped by the no-schedule rule — but a genuinely unscheduled clock-in still
  // should. The discriminator: was the user rostered for a WORK shift SOMEWHERE
  // that day? If yes it's a transfer (count the minutes, clamped raw); if no
  // it's the abnormal case (excluded). Keys are `${userId}:${date}`.
  rosteredSomewhere: Set<string>,
  // owner 2026-08-03: full-time users whose late arrival must NOT dock SVC minutes.
  // Their late clock-in is credited from the scheduled start (มาสายไม่หัก SVC — เป็น
  // ประวัติ; the monthly >20% forfeiture rule below is untouched and still applies).
  ftUserIds: Set<number>,
  excludedByUser: Map<number, Array<{ date: string; reason: string }>>
): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  const byDay = bucketEntriesByDay(entries);
  for (const [date, dayEntries] of byDay) {
    const byUser = new Map<number, Array<typeof entries[number]>>();
    for (const e of dayEntries) {
      if (!byUser.has(e.user_id)) byUser.set(e.user_id, []);
      byUser.get(e.user_id)!.push(e);
    }
    const userMin = new Map<number, number>();
    for (const [userId, list] of byUser) {
      const { shifts, unpaired } = pairShifts(list);
      // Irregular punch: a clock-in with no matching clock-out (unpaired>0), or
      // clock activity that pairs into nothing (a lone clock-out). SVC forfeits
      // the whole day (owner 2026-07-21: ไม่รับรองเวลา = ไม่รักษาสิทธิ์). Payroll
      // still pays it — that path is salary/roster-based, not clock-proportional.
      if (excludeAbnormal && list.length > 0 && (unpaired > 0 || shifts.length === 0)) {
        let arr = excludedByUser.get(userId);
        if (!arr) { arr = []; excludedByUser.set(userId, arr); }
        arr.push({ date, reason: unpaired > 0 ? "ลืมลงเวลาออก — เวลาไม่ครบ" : "ลืมลงเวลาเข้า — เวลาไม่ครบ" });
        continue;
      }
      const candidates = scheduledByUser.get(userId)?.get(date) ?? [];
      // Clocked but not rostered at THIS branch that day. Abnormal (no SVC) —
      // UNLESS the user was rostered for a work shift SOMEWHERE that day, which
      // means this is a legit mid-day branch transfer ("ย้ายสาขาระหว่างวัน", owner
      // 2026-08-02): count the transferred-in minutes (clamped raw, break
      // deducted below) so the destination branch's SVC pool includes them.
      if (excludeNoSchedule && shifts.length > 0 && candidates.length === 0
          && !rosteredSomewhere.has(`${userId}:${date}`)) {
        let arr = excludedByUser.get(userId);
        if (!arr) { arr = []; excludedByUser.set(userId, arr); }
        arr.push({ date, reason: "ลงเวลาวันที่ไม่มีกะในตาราง — ไม่นับ SVC" });
        continue;
      }
      const reqUntil = otByUser.get(userId)?.get(date);
      let total = 0;
      for (const sh of shifts) {
        const sched = candidates.length ? pickScheduled(candidates, sh) : null;
        // OT extends the cap past the scheduled end only when rostered + approved.
        const otUntilTs = (sched && reqUntil && /^\d{2}:\d{2}$/.test(reqUntil))
          ? new Date(`${date}T${reqUntil}:00+07:00`).toISOString()
          : null;
        const g = applyPtGrace(
          { startTs: sh.startTs, endTs: sh.endTs }, sched, otUntilTs, null,
          ftUserIds.has(userId)   // FT late → credit from scheduled start (no SVC dock)
        );
        total += g.breakMinutes > 0
          ? g.workedMinutes
          : deductBreak(g.workedMinutes, brk as PayrollSettings).workedMinutes;
      }
      if (total > 0) userMin.set(userId, Math.round(total));
    }
    out.set(date, userMin);
  }
  return out;
}

// ── Public: monthly summary ──────────────────────────────────────

type StaffMeta = {
  userId: number;
  displayName: string;
  employmentType: string | null;
  shiftStartTime: string | null;
  weeklyOffDays: string | null;
  trackAttendance: number;   // 0 = ผู้บริหารไม่ลงเวลา → นับ SVC จากตารางเวรแทน
  taxMode: string | null;    // 'sso' (รับเต็ม) | 'wht' (หัก ณ ที่จ่าย 3%)
  titlePrefix: string | null;
  employeeCode: string | null;
  hireDate: string | null;   // kept for other eligibility rules
  groupInsuranceStartMonth: string | null; // YYYY-MM the GI window counts from (owner 2026-08-02)
};

/** Build the full monthly SVC summary for a branch.
 *
 * Steps:
 *   1. Read every daily_service_charge row for the month
 *   2. Read every time_entries row for the month at this branch
 *   3. For each day with an amount + workers:
 *        staffPool   = amount × 0.6
 *        companyPool = amount × 0.4
 *        per worker = staffPool × (worker_minutes / total_worker_minutes)
 *   4. Sum each worker's per-day allocations across the month
 *   5. Apply forfeiture:
 *        - Monthly late minutes > 20% of scheduled minutes → forfeit
 *        - Resignation approved this month with forfeit_svc=1 → forfeit
 *   6. Total company pool = (sum of 40% splits) + (sum of forfeitures)
 *
 * scheduledMinutes per staff = workdays_in_month × 8h (matches the
 * monthly timesheet view's assumption). We don't subtract weekly_off
 * here for the same reason: maximum-benefit-of-the-doubt to staff. */
export function computeMonthlySvcSummary(
  branchId: number,
  yearMonth: string,
  opts?: { assumedShiftMinutes?: number }
): MonthlySvcSummary {
  // Pre-system months are entered by hand — take the manual path entirely
  // (owner 2026-07-21). No time entries / roster to compute over.
  if (isManualSvcMonth(yearMonth)) {
    return computeManualSvcSummary(branchId, yearMonth);
  }

  const db = getDb();
  const start = `${yearMonth}-01`;
  const end = `${yearMonth}-31`;
  const [yyyy, mm] = yearMonth.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(yyyy, mm, 0)).getUTCDate();
  const monthStartIso = new Date(`${start}T00:00:00+07:00`).toISOString();
  const monthEndIso = new Date(`${yearMonth}-${String(daysInMonth).padStart(2, "0")}T23:59:59+07:00`).toISOString();
  const assumedShift = opts?.assumedShiftMinutes ?? 8 * 60;

  // 1. Daily SVC amounts
  const dailyRows = db.prepare(`
    SELECT date, amount_baht FROM daily_service_charge
    WHERE branch_id = ? AND date >= ? AND date <= ?
  `).all(branchId, start, end) as Array<{ date: string; amount_baht: number }>;
  const amountByDate = new Map<string, number>();
  for (const r of dailyRows) amountByDate.set(r.date, r.amount_baht);
  const totalCollected = dailyRows.reduce((s, r) => s + r.amount_baht, 0);

  // 2. Branch roster + their settings
  // SVC eligibility is governed by the per-employee receives_service_charge flag,
  // decoupled from track_attendance (owner 2026-07-21). Default = everyone on the
  // branch (staff + admins/execs, whether or not they clock in) receives SVC;
  // only those explicitly ticked "ไม่รับ SVC" (receives_service_charge = 0) are
  // dropped. track_attendance now only decides clock-in/OT, not SVC.
  //
  // Eligibility filters mirror the payroll loader (payroll-compute.ts) so the
  // SVC roster matches who actually gets paid (owner 2026-07-20: คนลาออก/เลิกจ้าง/
  // เพิ่งเข้างานเดือนถัดไป/พนักงานทดสอบ ไม่ควรโผล่):
  //   - is_test_account = 0            → drop test accounts
  //   - status NOT IN (...)            → drop disabled/resigned/terminated (also
  //                                       de-dups people who have an old closed record)
  //   - hire_date IS NULL OR <= end    → a future hire doesn't belong in a past month
  const staff = db.prepare(`
    SELECT u.id AS userId, u.display_name AS displayName,
           u.employment_type AS employmentType,
           u.shift_start_time AS shiftStartTime,
           u.weekly_off_days AS weeklyOffDays,
           COALESCE(u.track_attendance, 1) AS trackAttendance,
           u.salary_tax_mode AS taxMode,
           u.title_prefix AS titlePrefix,
           u.employee_code AS employeeCode,
           u.hire_date AS hireDate,
           u.group_insurance_start_month AS groupInsuranceStartMonth
    FROM users u
    JOIN user_branches ub ON ub.user_id = u.id
    WHERE ub.branch_id = ? AND u.role IN ('staff', 'admin')
      AND u.receives_service_charge = 1
      AND u.is_test_account = 0
      AND u.status NOT IN ('disabled', 'resigned', 'terminated')
      AND (u.hire_date IS NULL OR u.hire_date <= ?)
    ORDER BY (u.employee_code IS NULL), u.employee_code COLLATE NOCASE ASC
  `).all(branchId, end) as StaffMeta[];

  // Cross-branch visitors (owner 2026-08-02, "ย้ายสาขาระหว่างวัน"): staff who are
  // NOT members of this branch but clocked in here this month via a mid-day
  // transfer. They join this branch's SVC pool for the days they actually worked
  // here, so their share "follows the branch worked". Same eligibility filters as
  // members. Group insurance is NOT withheld here — that ฿350/month is taken once
  // at their home branch, so charging it again at a visited branch would double it.
  const memberIds = new Set(staff.map((s) => s.userId));
  const visitorIds = new Set<number>();
  const visitorRows = db.prepare(`
    SELECT u.id AS userId, u.display_name AS displayName,
           u.employment_type AS employmentType,
           u.shift_start_time AS shiftStartTime,
           u.weekly_off_days AS weeklyOffDays,
           COALESCE(u.track_attendance, 1) AS trackAttendance,
           u.salary_tax_mode AS taxMode,
           u.title_prefix AS titlePrefix,
           u.employee_code AS employeeCode,
           u.hire_date AS hireDate,
           u.group_insurance_start_month AS groupInsuranceStartMonth
    FROM users u
    WHERE u.role IN ('staff', 'admin')
      AND u.receives_service_charge = 1
      AND u.is_test_account = 0
      AND u.status NOT IN ('disabled', 'resigned', 'terminated')
      AND (u.hire_date IS NULL OR u.hire_date <= ?)
      AND u.id IN (
        SELECT DISTINCT user_id FROM time_entries
        WHERE branch_id = ? AND ts >= ? AND ts <= ?
      )
  `).all(end, branchId, monthStartIso, monthEndIso) as StaffMeta[];
  for (const v of visitorRows) {
    if (memberIds.has(v.userId)) continue;
    visitorIds.add(v.userId);
    staff.push(v);
  }

  if (staff.length === 0) {
    return emptySummary(branchId, yearMonth, totalCollected, daysInMonth, dailyRows.length);
  }

  // 3. Time entries for the month at this branch
  const entries = db.prepare(`
    SELECT user_id, ts, type FROM time_entries
    WHERE branch_id = ? AND ts >= ? AND ts <= ?
  `).all(branchId, monthStartIso, monthEndIso) as
    Array<{ user_id: number; ts: string; type: "in" | "out" }>;

  // 3b. Scheduled shift windows (roster → shift_codes) for the branch/month.
  const scheduledByUser = buildScheduledByUser(branchId, start, end);

  // 3b2. Approved OT (owner 2026-07-21) — same source payroll uses. Extends the
  //      worked window past the shift end up to requested_until on approved days.
  const otByUser = new Map<number, Map<string, string>>();
  for (const r of db.prepare(`
    SELECT user_id, work_date, requested_until FROM ot_requests
    WHERE status = 'approved' AND work_date >= ? AND work_date <= ?
  `).all(start, end) as Array<{ user_id: number; work_date: string; requested_until: string }>) {
    let m = otByUser.get(r.user_id);
    if (!m) { m = new Map(); otByUser.set(r.user_id, m); }
    m.set(r.work_date, r.requested_until);
  }

  // 3c. Break-deduction settings (same table payroll uses) — for the fallback
  //     break when a shift has no scheduled break window (owner 2026-07-21).
  const brk = (db.prepare(`
    SELECT break_threshold_minutes, break_deduction_minutes,
           long_shift_threshold_minutes, long_shift_break_minutes
    FROM payroll_settings LIMIT 1
  `).get() as BreakSettings | undefined) ?? {
    break_threshold_minutes: 300, break_deduction_minutes: 30,
    long_shift_threshold_minutes: 480, long_shift_break_minutes: 60
  };

  // 4. Worked minutes per (date, user) — CLAMPED to the rostered shift like
  //    payroll: an early clock-in is counted from the shift start, break is
  //    deducted, OT past shift-end is not counted (owner 2026-07-21: นับเฉพาะ
  //    เวลาตามกะ). Matches the paid minutes in ค่าตอบแทน.
  // The "ตัดวันเวลาผิดปกติ" rule takes effect from June 2026 onward (owner
  // 2026-07-21 correction: มีผลมิถุนายนเป็นต้นไปเลย). June is the first system
  // month — pre-June is entered by hand (manual path above) — so in practice this
  // applies to every computed month.
  const excludeAbnormal = yearMonth >= SVC_SYSTEM_START_MONTH;
  // Two rules that start a month later than the abnormal exclusion (owner
  // 2026-07-21: ให้มีผลกรกฎาเป็นต้นไป):
  //   • excludeNoSchedule — a clock-in on a no-shift day earns no SVC
  //   • capNormalMinutes  — a normal day contributes at most 480 min (OT excepted)
  const excludeNoSchedule = yearMonth >= "2026-07";
  const capNormalMinutes = yearMonth >= "2026-07";
  const excludedByUser = new Map<number, Array<{ date: string; reason: string }>>();
  // Days each user was rostered for a work shift at ANY branch — lets a genuine
  // branch transfer bypass the no-schedule exclusion at the visited branch, while
  // a truly unscheduled clock-in stays excluded (owner 2026-08-02). Scoped to the
  // users we're paying so the set stays small.
  const rosteredSomewhere = new Set<string>();
  {
    const ids = staff.map((s) => s.userId);
    if (ids.length > 0) {
      const ph = ids.map(() => "?").join(",");
      for (const r of db.prepare(`
        SELECT DISTINCT ra.user_id AS uid, ra.assignment_date AS d
        FROM roster_assignments ra
        JOIN shift_codes sc ON sc.id = ra.shift_code_id
        WHERE sc.kind = 'work' AND ra.assignment_date >= ? AND ra.assignment_date <= ?
          AND ra.user_id IN (${ph})
      `).all(start, end, ...ids) as Array<{ uid: number; d: string }>) {
        rosteredSomewhere.add(`${r.uid}:${r.d}`);
      }
    }
  }
  // FT users — their lateness must not dock SVC minutes (owner 2026-08-03).
  const ftUserIds = new Set<number>(
    staff.filter((s) => s.employmentType === "ft").map((s) => s.userId)
  );
  const workedByDay = computeSvcClampedMinutesByDay(
    entries, scheduledByUser, otByUser, brk, excludeAbnormal, excludeNoSchedule,
    rosteredSomewhere, ftUserIds, excludedByUser
  );

  // 4b. Executives with track_attendance=0 don't clock in — accrue SVC from the
  //     roster instead: each kind='work' day they're scheduled counts as the
  //     ACTUAL rostered shift length (net of break — e.g. NPF = 8h), not a flat
  //     8h, so they join that day's proportional split like any other worker
  //     (owner 2026-07-21: นับตามกะที่ลงในตารางเวร).
  for (const s of staff) {
    if (s.trackAttendance !== 0) continue;
    const byDate = scheduledByUser.get(s.userId);
    if (!byDate) continue;
    for (const [d, windows] of byDate) {
      const net = windows.reduce((sum, w) => sum + netScheduledMinutes(w), 0);
      if (net <= 0) continue;
      let dayMap = workedByDay.get(d);
      if (!dayMap) { dayMap = new Map<number, number>(); workedByDay.set(d, dayMap); }
      dayMap.set(s.userId, Math.round(net));
    }
  }

  // 4c. Cap a normal day at 480 min (owner 2026-07-21, July+). A day only exceeds
  //     the cap when it has an approved OT record — those are already bounded to
  //     the approved end-time by applyPtGrace, so they're left uncapped here.
  //     Applies to both clocked and roster-credited (exec) minutes.
  if (capNormalMinutes) {
    for (const [d, dayMap] of workedByDay) {
      for (const [userId, mins] of dayMap) {
        if (mins > SVC_MAX_NORMAL_MINUTES && !otByUser.get(userId)?.has(d)) {
          dayMap.set(userId, SVC_MAX_NORMAL_MINUTES);
        }
      }
    }
  }

  // 5. Build per-staff accumulator
  const acc = new Map<number, {
    minutesWorked: number;
    daysWorked: number;
    grossAllocation: number;
  }>();
  for (const s of staff) {
    acc.set(s.userId, { minutesWorked: 0, daysWorked: 0, grossAllocation: 0 });
  }

  // 6. Per-day split: for each day that has BOTH an SVC amount and
  //    workers, distribute the staff pool proportionally.
  const breakdownByUser = new Map<number, MonthlySvcRow["dailyBreakdown"]>();
  for (const [date, amount] of amountByDate) {
    const userMins = workedByDay.get(date);
    if (!userMins || userMins.size === 0) continue;
    // Only eligible staff on THIS branch's SVC roster share the pool — and only
    // their minutes form the divisor. A clock-in from someone not on the roster
    // (another branch's staff, an excluded/resigned account, an admin who clocks
    // in) must not dilute everyone else's share (owner 2026-07-21: คนไม่ได้อยู่
    // สาขานี้กลายเป็นตัวหาร).
    let totalMins = 0;
    for (const [userId, mins] of userMins) {
      if (acc.has(userId)) totalMins += mins;
    }
    if (totalMins <= 0) continue;
    const staffPool = amount * SVC_STAFF_SHARE_RATIO;
    for (const [userId, mins] of userMins) {
      const a = acc.get(userId);
      if (!a) continue;  // clocked in at this branch but isn't on its SVC roster — excluded above
      const share = staffPool * (mins / totalMins);
      a.minutesWorked += mins;
      a.daysWorked += 1;
      a.grossAllocation += share;
      let bd = breakdownByUser.get(userId);
      if (!bd) { bd = []; breakdownByUser.set(userId, bd); }
      bd.push({ date, dayAmount: amount, staffPool, userMinutes: mins, totalMinutes: totalMins, share });
    }
  }

  // 6b. Food-credit clawback (owner 2026-07-30; MEALPASS 2.0 source 2026-08-09).
  //     A staffer who took an in-house MEALPASS meal (a confirmed order that
  //     burned credits) but whose CLAMPED worked minutes that day fell below
  //     FOOD_CLAWBACK_MIN_MINUTES (480−30) — i.e. left the ≥8h shift early —
  //     forfeits that meal's credit value from their SVC, UNLESS they have an
  //     approved early-leave for the day. We only claw back on days we can
  //     actually measure (present in workedByDay); an abnormal/uncertified day
  //     (already SVC-excluded) is skipped so we never double-penalise. Cash
  //     meals (credits = 0) carry nothing to claw. Scoped to the selling branch
  //     = the shift they worked = this SVC branch's day. (Old meal_coupons
  //     source retired — the coupon module was replaced by MEALPASS 2.0.)
  const earlyLeaveKeys = approvedEarlyLeaveKeys(db, yearMonth);
  const redeemedFood = db.prepare(`
    SELECT user_id AS uid, order_date AS d, credits AS credit
      FROM mealpass_orders
     WHERE kind = 'meal' AND status = 'confirmed' AND branch_id = ?
       AND order_date >= ? AND order_date <= ?
       AND credits > 0
  `).all(branchId, start, end) as Array<{ uid: number; d: string; credit: number }>;
  const clawbackByUser = computeFoodClawbacks(
    redeemedFood, workedByDay, earlyLeaveKeys, (uid) => acc.has(uid)
  );

  // 7. Late stats per user (for forfeiture check)
  const inEntries = entries.filter((e) => e.type === "in");
  const insByUser = new Map<number, Array<{ ts: string }>>();
  for (const e of inEntries) {
    if (!insByUser.has(e.user_id)) insByUser.set(e.user_id, []);
    insByUser.get(e.user_id)!.push({ ts: e.ts });
  }

  // 8. Resignation forfeits — fetch any approved resignation in this
  //    month flagged with forfeit_svc. We match by decided_at falling
  //    inside the period.
  const forfeitedFromResign = new Set<number>();
  const resignRows = db.prepare(`
    SELECT user_id FROM resignation_requests
    WHERE status = 'approved'
      AND forfeit_svc = 1
      AND decided_at >= ? AND decided_at <= ?
  `).all(monthStartIso, monthEndIso) as Array<{ user_id: number }>;
  for (const r of resignRows) forfeitedFromResign.add(r.user_id);

  // 8b. Executive forfeiture exemptions for the month (owner 2026-08-20).
  const exemptedSet = listSvcForfeitExemptions(yearMonth);

  // 9. Roll up per-staff rows + forfeiture
  //
  // Lateness here uses the per-day roster shift start when assigned,
  // falling back to users.shift_start_time otherwise — same rule as
  // the daily attendance summary, so all three views (SVC monthly,
  // monthly timesheet, daily summary) agree on which clock-ins are
  // "late".
  //
  // scheduledMinutes — prefer roster-assigned minutes for the month;
  // fall back to the conservative daysInMonth × 8h when the roster
  // is empty for that user (legacy behaviour).
  const fallbackScheduledMinutes = daysInMonth * assumedShift;
  const userIds = staff.map((s) => s.userId);
  const rosterScheduledByUser = scheduledMinutesByUserForMonth(branchId, yearMonth, userIds);

  // WHT rate for the payout — same 3% payroll uses (payroll_settings.wht_rate),
  // falling back to 0.03 if settings are missing (owner 2026-07-21).
  const whtRate = (db.prepare("SELECT wht_rate FROM payroll_settings LIMIT 1")
    .get() as { wht_rate: number } | undefined)?.wht_rate ?? 0.03;
  const round2 = (n: number) => Math.round(n * 100) / 100;

  const rows: MonthlySvcRow[] = staff.map((s) => {
    const a = acc.get(s.userId) ?? { minutesWorked: 0, daysWorked: 0, grossAllocation: 0 };
    // A cross-branch visitor's lateness / forfeiture / group-insurance are judged
    // at their HOME branch, not here — a 13:00 transfer-in would otherwise look
    // hours "late" against their morning shift and wrongly forfeit their share
    // (owner 2026-08-02). Here they only collect the pool for minutes worked.
    const isVisitor = visitorIds.has(s.userId);
    const rosterShiftByDate = shiftStartByDateForUserMonth(branchId, s.userId, yearMonth);
    const rosterMin = rosterScheduledByUser.get(s.userId) ?? 0;
    const scheduledMinutes = rosterMin > 0 ? rosterMin : fallbackScheduledMinutes;

    // Lateness — per-event: look up effective shift start from roster
    // first, then fall back to the static users.shift_start_time. If
    // neither exists for a given event, that event simply isn't
    // counted as late (no scheduled shift = no expectation). Visitors are
    // skipped entirely (their punches here are transfer-ins, not their shift).
    let lateMinutes = 0;
    let anyComputable = false;
    for (const ev of (isVisitor ? [] : (insByUser.get(s.userId) ?? []))) {
      const bkk = new Date(new Date(ev.ts).getTime() + 7 * 60 * 60 * 1000);
      const dateBkk = bkk.toISOString().slice(0, 10);
      const effStart = rosterShiftByDate.get(dateBkk) ?? s.shiftStartTime;
      if (!effStart) continue;
      anyComputable = true;
      const startMin = hhmmToMin(effStart);
      if (startMin == null) continue;
      const actualMin = bkk.getUTCHours() * 60 + bkk.getUTCMinutes();
      const diff = actualMin - startMin;
      if (diff > LATE_GRACE_MINUTES) lateMinutes += diff;
    }
    const lateRatio = scheduledMinutes > 0 ? lateMinutes / scheduledMinutes : 0;
    const lateForfeit = anyComputable && lateRatio > SC_INELIGIBILITY_THRESHOLD;
    const resignForfeit = forfeitedFromResign.has(s.userId);
    // Executive exemption (owner 2026-08-20): the automatic rule still decides the
    // reason, but if this (user, month) is exempted the forfeiture is waived and
    // they are paid. isVisitor's exemption is judged at their home branch, but the
    // exemption set is company-wide (per user+month) so it applies here too.
    const wouldForfeit = lateForfeit || resignForfeit;
    const wouldReason: "late_20pct" | "resignation" | null =
      wouldForfeit ? (resignForfeit ? "resignation" : "late_20pct") : null;
    const exempted = wouldForfeit && exemptedSet.has(s.userId);
    const forfeited = wouldForfeit && !exempted;
    // Name: mirror payroll — carry display_name + title_prefix and compose with
    // nameWithPrefix (owner 2026-07-21: ใช้วิธีเดียวกับหน้าค่าตอบแทน). Staff with a
    // title_prefix show it; staff with none show display_name as-is (owner fills
    // the คำนำหน้า in the employee editor — the system does not guess).
    const displayName = nameWithPrefix(s.titlePrefix, s.displayName);
    // Food-credit clawback (owner 2026-07-30) — applied on top of forfeiture.
    // A forfeited month already pays 0, so there's nothing to recover then; only
    // clamp against the actual gross so we never claw back more than they earned.
    const clawDays = clawbackByUser.get(s.userId) ?? [];
    const rawClawback = clawDays.reduce((sum, x) => sum + x.credit, 0);
    const foodClawback = forfeited ? 0 : Math.min(rawClawback, round2(a.grossAllocation));
    // WHT: 'wht' staff have 3% withheld from their SVC payout; 'sso' staff get
    // the full net (owner 2026-07-21). Applied after forfeiture (forfeited = 0)
    // and after the food clawback.
    const netAllocation = forfeited ? 0 : round2(a.grossAllocation - foodClawback);
    const taxMode: "sso" | "wht" = s.taxMode === "wht" ? "wht" : "sso";
    const whtAmount = taxMode === "wht" ? round2(netAllocation * whtRate) : 0;
    // Group-insurance premium (owner 2026-08-02) — withheld from the SVC left
    // after forfeit + WHT, during the new-hire window (FT 3mo / PT 12mo). Skipped
    // for visitors so the ฿350/month isn't double-charged (it's taken at home).
    const groupInsurance = isVisitor ? 0 : groupInsuranceDeduction({
      employmentType: s.employmentType,
      startMonth: s.groupInsuranceStartMonth,
      yearMonth,
      availablePayout: round2(netAllocation - whtAmount)
    });
    const netPayout = round2(netAllocation - whtAmount - groupInsurance);
    return {
      userId: s.userId,
      displayName,
      employmentType: s.employmentType,
      shiftStartTime: s.shiftStartTime,
      totalMinutesWorked: a.minutesWorked,
      daysWorked: a.daysWorked,
      scheduledMinutes,
      lateMinutes,
      lateRatio,
      grossAllocation: a.grossAllocation,
      forfeited,
      forfeitReason: forfeited ? wouldReason : null,
      exempted,
      exemptReason: exempted ? wouldReason : null,
      netAllocation,
      taxMode,
      whtAmount,
      groupInsurance,
      netPayout,
      dailyBreakdown: breakdownByUser.get(s.userId) ?? [],
      excludedDays: (excludedByUser.get(s.userId) ?? []).slice().sort((a, b) => a.date.localeCompare(b.date)),
      foodClawback,
      foodClawbackDays: foodClawback > 0 ? clawDays.slice().sort((a, b) => a.date.localeCompare(b.date)) : []
    };
  });

  // 10. Company pool totals
  const staffPoolTotal = totalCollected * SVC_STAFF_SHARE_RATIO;
  const companyFromSplit = totalCollected * SVC_COMPANY_SHARE_RATIO;
  const companyFromForfeit = rows.reduce(
    (s, r) => s + (r.forfeited ? r.grossAllocation : 0), 0
  );
  // Food-credit clawbacks recovered from staff shares also flow to the company
  // pool (owner 2026-07-30).
  const companyFromClawback = round2(rows.reduce((s, r) => s + r.foodClawback, 0));
  const totalWht = rows.reduce((s, r) => s + r.whtAmount, 0);
  const totalGroupInsurance = round2(rows.reduce((s, r) => s + r.groupInsurance, 0));
  const totalNetPayout = rows.reduce((s, r) => s + r.netPayout, 0);

  return {
    branchId,
    yearMonth,
    totalCollected,
    staffPoolTotal,
    companyPoolFromSplit: companyFromSplit,
    companyPoolFromForfeit: companyFromForfeit,
    companyPoolFromClawback: companyFromClawback,
    companyPoolTotal: companyFromSplit + companyFromForfeit + companyFromClawback,
    totalWht,
    totalGroupInsurance,
    totalNetPayout,
    rows,
    daysWithEntries: dailyRows.length,
    daysInMonth,
    payoutDate: computePayoutDate(yearMonth),
    manualEntry: false
  };
}

// ── Company-wide SVC summary (owner 2026-08-18) ───────────────────────────
// The owner wants SVC viewed for the WHOLE company on one page (branches pay out
// together the same day), with a per-branch split for people who worked more than
// one branch ("ได้จากสาขาไหนเท่าไหร่"). This reuses the tested per-branch engine
// for the hard daily distribution, then RE-DOES the monthly roll-up (late
// forfeiture, food clawback, WHT, group insurance) ONCE at the company level so a
// cross-branch worker isn't judged/charged twice.
//
// A second mode — "รวมกอง" (shared pool, per (company, month) toggle) — pools every
// branch's daily amount and splits it across everyone who worked that day so a
// worker at a branch that hasn't entered SVC (e.g. a new HYPO) still gets a share.
// That mode is layered on top separately.

export type CompanySvcBranchShare = {
  branchId: number;
  branchName: string;
  grossAllocation: number;   // pre-forfeit accrual earned at THIS branch
  daysWorked: number;
  minutesWorked: number;
};

export type CompanySvcRow = {
  userId: number;
  displayName: string;
  employmentType: string | null;
  // แยกให้เห็นว่าได้จากสาขาไหนเท่าไหร่ (owner 2026-08-18)
  byBranch: CompanySvcBranchShare[];
  // Company-level roll-up (judged once across all branches)
  grossAllocation: number;   // Σ byBranch (pre-forfeit)
  lateMinutes: number;
  scheduledMinutes: number;  // real roster minutes across branches (fallback once)
  lateRatio: number;
  forfeited: boolean;
  forfeitReason: "late_20pct" | "resignation" | null;
  exempted: boolean;
  exemptReason: "late_20pct" | "resignation" | null;
  foodClawback: number;
  netAllocation: number;
  taxMode: "sso" | "wht";
  whtAmount: number;
  groupInsurance: number;
  netPayout: number;
  dailyBreakdown: Array<{
    date: string; branchId: number; branchName: string;
    dayAmount: number; staffPool: number; userMinutes: number; totalMinutes: number; share: number;
  }>;
};

export type CompanySvcSummary = {
  companyId: number;
  yearMonth: string;
  shared: boolean;           // true = รวมกอง SVC ทั้งบริษัท เดือนนี้
  branches: Array<{ branchId: number; branchName: string; totalCollected: number }>;
  totalCollected: number;
  staffPoolTotal: number;
  companyPoolTotal: number;
  totalWht: number;
  totalGroupInsurance: number;
  totalNetPayout: number;
  rows: CompanySvcRow[];
  payoutDate: string;
};

/** Users whose SVC forfeiture is WAIVED for a month (owner 2026-08-20) — an
 *  executive override. The forfeiture rule still computes the reason; presence
 *  here just flips `forfeited` back to false so they are paid. Keyed per user. */
export function listSvcForfeitExemptions(yearMonth: string): Set<number> {
  const rows = getDb().prepare(
    "SELECT user_id FROM svc_forfeit_exemptions WHERE year_month = ?"
  ).all(yearMonth) as Array<{ user_id: number }>;
  return new Set(rows.map((r) => r.user_id));
}

/** Turn a (user, month) SVC-forfeiture exemption on/off (owner 2026-08-20). */
export function setSvcForfeitExemption(args: {
  userId: number; yearMonth: string; exempted: boolean; byUserId: number; note?: string | null;
}): void {
  const db = getDb();
  if (args.exempted) {
    db.prepare(`
      INSERT INTO svc_forfeit_exemptions (user_id, year_month, exempted_by_user_id, exempted_at, note)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, year_month) DO UPDATE SET
        exempted_by_user_id = excluded.exempted_by_user_id,
        exempted_at = excluded.exempted_at, note = excluded.note
    `).run(args.userId, args.yearMonth, args.byUserId, new Date().toISOString(), args.note ?? null);
  } else {
    db.prepare("DELETE FROM svc_forfeit_exemptions WHERE user_id = ? AND year_month = ?")
      .run(args.userId, args.yearMonth);
  }
}

/** Is the (company, month) flagged to pool SVC across all its branches? (owner
 *  2026-08-18). A row in svc_shared_pool = shared ON for that month. */
export function isSharedSvcMonth(companyId: number, yearMonth: string): boolean {
  return !!getDb().prepare(
    "SELECT 1 FROM svc_shared_pool WHERE company_id = ? AND year_month = ?"
  ).get(companyId, yearMonth);
}

/** Turn the company-wide shared-pool toggle on/off for a (company, month). */
export function setSharedSvcMonth(args: {
  companyId: number; yearMonth: string; shared: boolean; userId: number;
}): void {
  const db = getDb();
  if (args.shared) {
    db.prepare(`
      INSERT INTO svc_shared_pool (company_id, year_month, enabled_by_user_id, enabled_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(company_id, year_month) DO UPDATE SET
        enabled_by_user_id = excluded.enabled_by_user_id, enabled_at = excluded.enabled_at
    `).run(args.companyId, args.yearMonth, args.userId, new Date().toISOString());
  } else {
    db.prepare("DELETE FROM svc_shared_pool WHERE company_id = ? AND year_month = ?")
      .run(args.companyId, args.yearMonth);
  }
}

// ── Per-branch SVC context (worked minutes + eligibility) ─────────────────
// The pool-INDEPENDENT half of a branch's monthly SVC: who is SVC-eligible here
// (members + mid-day transfer visitors), how many CLAMPED minutes each worked per
// day, their lateness, resignation-forfeit and food-clawback inputs. This mirrors
// steps 2–8 of computeMonthlySvcSummary — reusing the SAME minute helpers
// (buildScheduledByUser / computeSvcClampedMinutesByDay / netScheduledMinutes /
// computeFoodClawbacks) so the clamping is identical — and returns the
// intermediates. The company shared-pool mode ("รวมกอง") layers a POOLED daily
// amount across every branch on top of these (owner 2026-08-18).
//
// IMPORTANT: the branch page (computeMonthlySvcSummary) is untouched and remains
// the source of truth for a single branch. This context is used ONLY by the
// company shared-pool view, where the distribution is INTENTIONALLY different
// (one pool split across all branches). Keep the minute logic below in sync with
// computeMonthlySvcSummary if that engine's clamping rules change.
type BranchSvcContext = {
  totalCollected: number;
  amountByDate: Map<string, number>;
  staff: StaffMeta[];
  memberIds: Set<number>;
  visitorIds: Set<number>;
  workedByDay: Map<string, Map<number, number>>;      // clamped + capped + exec-credit
  otUserDates: Set<string>;                           // "uid:date" with approved OT (skip 480 cap)
  redeemedFood: Array<{ uid: number; d: string; credit: number }>;  // confirmed meals w/ credit
  lateByUser: Map<number, { lateMinutes: number; anyComputable: boolean }>;
  rosterScheduledByUser: Map<number, number>;         // real roster minutes (0 if none)
  forfeitedFromResign: Set<number>;
};

function computeBranchSvcContext(branchId: number, yearMonth: string): BranchSvcContext {
  const db = getDb();
  const start = `${yearMonth}-01`;
  const end = `${yearMonth}-31`;
  const [yyyy, mm] = yearMonth.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(yyyy, mm, 0)).getUTCDate();
  const monthStartIso = new Date(`${start}T00:00:00+07:00`).toISOString();
  const monthEndIso = new Date(`${yearMonth}-${String(daysInMonth).padStart(2, "0")}T23:59:59+07:00`).toISOString();

  // 1. Daily SVC amounts
  const dailyRows = db.prepare(`
    SELECT date, amount_baht FROM daily_service_charge
    WHERE branch_id = ? AND date >= ? AND date <= ?
  `).all(branchId, start, end) as Array<{ date: string; amount_baht: number }>;
  const amountByDate = new Map<string, number>();
  for (const r of dailyRows) amountByDate.set(r.date, r.amount_baht);
  const totalCollected = dailyRows.reduce((s, r) => s + r.amount_baht, 0);

  // 2. Branch roster (members) — same eligibility filters as computeMonthlySvcSummary.
  const staff = db.prepare(`
    SELECT u.id AS userId, u.display_name AS displayName,
           u.employment_type AS employmentType,
           u.shift_start_time AS shiftStartTime,
           u.weekly_off_days AS weeklyOffDays,
           COALESCE(u.track_attendance, 1) AS trackAttendance,
           u.salary_tax_mode AS taxMode,
           u.title_prefix AS titlePrefix,
           u.employee_code AS employeeCode,
           u.hire_date AS hireDate,
           u.group_insurance_start_month AS groupInsuranceStartMonth
    FROM users u
    JOIN user_branches ub ON ub.user_id = u.id
    WHERE ub.branch_id = ? AND u.role IN ('staff', 'admin')
      AND u.receives_service_charge = 1
      AND u.is_test_account = 0
      AND u.status NOT IN ('disabled', 'resigned', 'terminated')
      AND (u.hire_date IS NULL OR u.hire_date <= ?)
    ORDER BY (u.employee_code IS NULL), u.employee_code COLLATE NOCASE ASC
  `).all(branchId, end) as StaffMeta[];

  // 2b. Mid-day transfer visitors — clocked here but members elsewhere.
  const memberIds = new Set(staff.map((s) => s.userId));
  const visitorIds = new Set<number>();
  const visitorRows = db.prepare(`
    SELECT u.id AS userId, u.display_name AS displayName,
           u.employment_type AS employmentType,
           u.shift_start_time AS shiftStartTime,
           u.weekly_off_days AS weeklyOffDays,
           COALESCE(u.track_attendance, 1) AS trackAttendance,
           u.salary_tax_mode AS taxMode,
           u.title_prefix AS titlePrefix,
           u.employee_code AS employeeCode,
           u.hire_date AS hireDate,
           u.group_insurance_start_month AS groupInsuranceStartMonth
    FROM users u
    WHERE u.role IN ('staff', 'admin')
      AND u.receives_service_charge = 1
      AND u.is_test_account = 0
      AND u.status NOT IN ('disabled', 'resigned', 'terminated')
      AND (u.hire_date IS NULL OR u.hire_date <= ?)
      AND u.id IN (
        SELECT DISTINCT user_id FROM time_entries
        WHERE branch_id = ? AND ts >= ? AND ts <= ?
      )
  `).all(end, branchId, monthStartIso, monthEndIso) as StaffMeta[];
  for (const v of visitorRows) {
    if (memberIds.has(v.userId)) continue;
    visitorIds.add(v.userId);
    staff.push(v);
  }

  // 3. Time entries + roster windows + OT + break settings.
  const entries = db.prepare(`
    SELECT user_id, ts, type FROM time_entries
    WHERE branch_id = ? AND ts >= ? AND ts <= ?
  `).all(branchId, monthStartIso, monthEndIso) as
    Array<{ user_id: number; ts: string; type: "in" | "out" }>;
  const scheduledByUser = buildScheduledByUser(branchId, start, end);
  const otByUser = new Map<number, Map<string, string>>();
  for (const r of db.prepare(`
    SELECT user_id, work_date, requested_until FROM ot_requests
    WHERE status = 'approved' AND work_date >= ? AND work_date <= ?
  `).all(start, end) as Array<{ user_id: number; work_date: string; requested_until: string }>) {
    let m = otByUser.get(r.user_id);
    if (!m) { m = new Map(); otByUser.set(r.user_id, m); }
    m.set(r.work_date, r.requested_until);
  }
  const brk = (db.prepare(`
    SELECT break_threshold_minutes, break_deduction_minutes,
           long_shift_threshold_minutes, long_shift_break_minutes
    FROM payroll_settings LIMIT 1
  `).get() as BreakSettings | undefined) ?? {
    break_threshold_minutes: 300, break_deduction_minutes: 30,
    long_shift_threshold_minutes: 480, long_shift_break_minutes: 60
  };

  // 4. Clamped worked minutes per (date, user) — same gates as the branch engine.
  const excludeAbnormal = yearMonth >= SVC_SYSTEM_START_MONTH;
  const excludeNoSchedule = yearMonth >= "2026-07";
  const capNormalMinutes = yearMonth >= "2026-07";
  const excludedByUser = new Map<number, Array<{ date: string; reason: string }>>();
  const rosteredSomewhere = new Set<string>();
  {
    const ids = staff.map((s) => s.userId);
    if (ids.length > 0) {
      const ph = ids.map(() => "?").join(",");
      for (const r of db.prepare(`
        SELECT DISTINCT ra.user_id AS uid, ra.assignment_date AS d
        FROM roster_assignments ra
        JOIN shift_codes sc ON sc.id = ra.shift_code_id
        WHERE sc.kind = 'work' AND ra.assignment_date >= ? AND ra.assignment_date <= ?
          AND ra.user_id IN (${ph})
      `).all(start, end, ...ids) as Array<{ uid: number; d: string }>) {
        rosteredSomewhere.add(`${r.uid}:${r.d}`);
      }
    }
  }
  const ftUserIds = new Set<number>(
    staff.filter((s) => s.employmentType === "ft").map((s) => s.userId)
  );
  const workedByDay = computeSvcClampedMinutesByDay(
    entries, scheduledByUser, otByUser, brk, excludeAbnormal, excludeNoSchedule,
    rosteredSomewhere, ftUserIds, excludedByUser
  );
  // 4b. Execs (track_attendance=0) accrue from the roster.
  for (const s of staff) {
    if (s.trackAttendance !== 0) continue;
    const byDate = scheduledByUser.get(s.userId);
    if (!byDate) continue;
    for (const [d, windows] of byDate) {
      const net = windows.reduce((sum, w) => sum + netScheduledMinutes(w), 0);
      if (net <= 0) continue;
      let dayMap = workedByDay.get(d);
      if (!dayMap) { dayMap = new Map<number, number>(); workedByDay.set(d, dayMap); }
      dayMap.set(s.userId, Math.round(net));
    }
  }
  // 4c. Cap a normal day at 480 (OT excepted).
  if (capNormalMinutes) {
    for (const [d, dayMap] of workedByDay) {
      for (const [userId, mins] of dayMap) {
        if (mins > SVC_MAX_NORMAL_MINUTES && !otByUser.get(userId)?.has(d)) {
          dayMap.set(userId, SVC_MAX_NORMAL_MINUTES);
        }
      }
    }
  }

  // 4d. Days each user had approved OT here (skip the 480 cap on a combined day).
  const otUserDates = new Set<string>();
  for (const [uid, dates] of otByUser) for (const d of dates.keys()) otUserDates.add(`${uid}:${d}`);

  // 5. Food-credit redemptions at this branch (raw — the clawback decision is made
  //    at the company level so a mid-day-transfer full day isn't wrongly clawed).
  const redeemedFood = db.prepare(`
    SELECT user_id AS uid, order_date AS d, credits AS credit
      FROM mealpass_orders
     WHERE kind = 'meal' AND status = 'confirmed' AND branch_id = ?
       AND order_date >= ? AND order_date <= ?
       AND credits > 0
  `).all(branchId, start, end) as Array<{ uid: number; d: string; credit: number }>;

  // 6. Lateness per user (for the >20% forfeiture at company roll-up). Visitors'
  //    punches here are transfer-ins, not their own shift — skip (judged at home).
  const inEntries = entries.filter((e) => e.type === "in");
  const insByUser = new Map<number, Array<{ ts: string }>>();
  for (const e of inEntries) {
    if (!insByUser.has(e.user_id)) insByUser.set(e.user_id, []);
    insByUser.get(e.user_id)!.push({ ts: e.ts });
  }
  const userIds = staff.map((s) => s.userId);
  const rosterScheduledByUser = scheduledMinutesByUserForMonth(branchId, yearMonth, userIds);
  const lateByUser = new Map<number, { lateMinutes: number; anyComputable: boolean }>();
  for (const s of staff) {
    const isVisitor = visitorIds.has(s.userId);
    const rosterShiftByDate = shiftStartByDateForUserMonth(branchId, s.userId, yearMonth);
    let lateMinutes = 0;
    let anyComputable = false;
    for (const ev of (isVisitor ? [] : (insByUser.get(s.userId) ?? []))) {
      const bkk = new Date(new Date(ev.ts).getTime() + 7 * 60 * 60 * 1000);
      const dateBkk = bkk.toISOString().slice(0, 10);
      const effStart = rosterShiftByDate.get(dateBkk) ?? s.shiftStartTime;
      if (!effStart) continue;
      anyComputable = true;
      const startMin = hhmmToMin(effStart);
      if (startMin == null) continue;
      const actualMin = bkk.getUTCHours() * 60 + bkk.getUTCMinutes();
      const diff = actualMin - startMin;
      if (diff > LATE_GRACE_MINUTES) lateMinutes += diff;
    }
    lateByUser.set(s.userId, { lateMinutes, anyComputable });
  }

  // 7. Resignation forfeits (company-wide query — same for every branch).
  const forfeitedFromResign = new Set<number>();
  for (const r of db.prepare(`
    SELECT user_id FROM resignation_requests
    WHERE status = 'approved' AND forfeit_svc = 1
      AND decided_at >= ? AND decided_at <= ?
  `).all(monthStartIso, monthEndIso) as Array<{ user_id: number }>) {
    forfeitedFromResign.add(r.user_id);
  }

  return {
    totalCollected, amountByDate, staff, memberIds, visitorIds, workedByDay,
    otUserDates, redeemedFood, lateByUser, rosterScheduledByUser, forfeitedFromResign
  };
}

/** Final per-user arithmetic shared by both company modes (owner 2026-08-18):
 *  forfeiture (late >20% OR resignation), food clawback, WHT, group insurance.
 *  Pool-DEPENDENT inputs (gross / byBranch / breakdown) are computed by the
 *  caller; the pool-independent late/schedule/resign/clawback/meta come from the
 *  branch contexts. skipGroupInsurance is set for a person who is a member of NO
 *  branch in this company (a cross-company visitor — their ฿350 is taken at home). */
function rollupCompanyRow(input: {
  userId: number; displayName: string; employmentType: string | null;
  byBranch: CompanySvcBranchShare[]; breakdown: CompanySvcRow["dailyBreakdown"];
  grossRaw: number; lateMinutes: number; anyComputable: boolean;
  realScheduledMinutes: number; fallbackScheduled: number;
  resignForfeit: boolean; rawFoodClawback: number;
  taxMode: "sso" | "wht"; giStartMonth: string | null; skipGroupInsurance: boolean;
  exempted: boolean;   // executive override — waive the automatic forfeiture (owner 2026-08-20)
  yearMonth: string; whtRate: number;
}): CompanySvcRow {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const gross = round2(input.grossRaw);
  const scheduledMinutes = input.realScheduledMinutes > 0 ? input.realScheduledMinutes : input.fallbackScheduled;
  const lateRatio = scheduledMinutes > 0 ? input.lateMinutes / scheduledMinutes : 0;
  const lateForfeit = input.anyComputable && lateRatio > SC_INELIGIBILITY_THRESHOLD;
  const wouldForfeit = lateForfeit || input.resignForfeit;
  const wouldReason: "late_20pct" | "resignation" | null =
    wouldForfeit ? (input.resignForfeit ? "resignation" : "late_20pct") : null;
  const exempted = wouldForfeit && input.exempted;
  const forfeited = wouldForfeit && !exempted;
  const foodClawback = forfeited ? 0 : Math.min(round2(input.rawFoodClawback), gross);
  const netAllocation = forfeited ? 0 : round2(gross - foodClawback);
  const whtAmount = input.taxMode === "wht" ? round2(netAllocation * input.whtRate) : 0;
  const groupInsurance = input.skipGroupInsurance ? 0 : groupInsuranceDeduction({
    employmentType: input.employmentType,
    startMonth: input.giStartMonth,
    yearMonth: input.yearMonth,
    availablePayout: round2(netAllocation - whtAmount)
  });
  const netPayout = round2(netAllocation - whtAmount - groupInsurance);
  return {
    userId: input.userId, displayName: input.displayName, employmentType: input.employmentType,
    byBranch: input.byBranch,
    grossAllocation: gross, lateMinutes: input.lateMinutes, scheduledMinutes, lateRatio,
    forfeited,
    forfeitReason: forfeited ? wouldReason : null,
    exempted,
    exemptReason: exempted ? wouldReason : null,
    foodClawback, netAllocation, taxMode: input.taxMode, whtAmount, groupInsurance, netPayout,
    dailyBreakdown: input.breakdown.slice().sort((x, y) => x.date.localeCompare(y.date))
  };
}

/** "รวมกอง" shared-pool company summary (owner 2026-08-18). Each DAY, every branch's
 *  SVC amount is POOLED and the 60% staff share is split across everyone who worked
 *  at ANY branch that day, weighted by their clamped worked minutes (ตามชั่วโมง
 *  ทำงานจริง). A worker at a branch that entered no SVC (e.g. a new HYPO) still gets
 *  a share of the pooled amount. Each person's share is attributed to the branch(es)
 *  they actually worked at ("ได้จากสาขาไหนเท่าไหร่"). Roll-up (forfeit / clawback /
 *  WHT / group insurance) is judged ONCE at company level. */
export function computeCompanySvcSummaryShared(companyId: number, yearMonth: string): CompanySvcSummary {
  const db = getDb();
  const branches = db.prepare(
    "SELECT id, name FROM branches WHERE company_id = ? ORDER BY display_order, name"
  ).all(companyId) as Array<{ id: number; name: string }>;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const whtRate = (db.prepare("SELECT wht_rate FROM payroll_settings LIMIT 1")
    .get() as { wht_rate: number } | undefined)?.wht_rate ?? 0.03;

  const contexts = branches.map((b) => ({ branch: b, ctx: computeBranchSvcContext(b.id, yearMonth) }));
  const branchNameById = new Map(branches.map((b) => [b.id, b.name]));

  // Company roster + membership (member of ANY branch → not a cross-company visitor).
  const memberIdsCompany = new Set<number>();
  const metaByUser = new Map<number, StaffMeta>();
  for (const { ctx } of contexts) {
    for (const id of ctx.memberIds) memberIdsCompany.add(id);
    for (const s of ctx.staff) if (!metaByUser.has(s.userId)) metaByUser.set(s.userId, s);
  }

  // Union of every day that either has a pooled amount OR someone worked.
  const allDates = new Set<string>();
  for (const { ctx } of contexts) {
    for (const d of ctx.amountByDate.keys()) allDates.add(d);
    for (const d of ctx.workedByDay.keys()) allDates.add(d);
  }

  type Acc = {
    byBranch: Map<number, CompanySvcBranchShare>;
    gross: number;
    breakdown: CompanySvcRow["dailyBreakdown"];
  };
  const accByUser = new Map<number, Acc>();
  const ensureAcc = (uid: number): Acc => {
    let a = accByUser.get(uid);
    if (!a) { a = { byBranch: new Map(), gross: 0, breakdown: [] }; accByUser.set(uid, a); }
    return a;
  };

  // A person's approved-OT lets a combined day exceed the 480-min cap.
  const hasOt = (userId: number, date: string) =>
    contexts.some(({ ctx }) => ctx.otUserDates.has(`${userId}:${date}`));

  // Combined clamped minutes per (date, user) across all branches — the basis for
  // the company-level food-clawback so a full 8h split across two branches
  // (240+240) is NOT wrongly clawed (owner 2026-08-18). Per-branch minutes are
  // already 480-capped in each context, so the sum reflects real worked time.
  const combinedWorkedByDay = new Map<string, Map<number, number>>();
  for (const { ctx } of contexts) {
    for (const [date, dayMap] of ctx.workedByDay) {
      let m = combinedWorkedByDay.get(date);
      if (!m) { m = new Map(); combinedWorkedByDay.set(date, m); }
      for (const [uid, mins] of dayMap) m.set(uid, (m.get(uid) ?? 0) + mins);
    }
  }

  // Attribute one share to a user at a branch (accumulate gross + byBranch + a
  // "วิธีคำนวณ" breakdown row).
  const addShare = (
    userId: number, branchId: number, share: number, minutes: number,
    bd: { date: string; dayAmount: number; staffPool: number; userMinutes: number; totalMinutes: number }
  ) => {
    if (share <= 0) return;
    const a = ensureAcc(userId);
    a.gross += share;
    const bn = branchNameById.get(branchId) ?? "";
    let bb = a.byBranch.get(branchId);
    if (!bb) { bb = { branchId, branchName: bn, grossAllocation: 0, daysWorked: 0, minutesWorked: 0 }; a.byBranch.set(branchId, bb); }
    bb.grossAllocation += share;
    bb.daysWorked += 1;
    bb.minutesWorked += minutes;
    a.breakdown.push({ date: bd.date, branchId, branchName: bn, dayAmount: bd.dayAmount, staffPool: bd.staffPool, userMinutes: minutes, totalMinutes: bd.totalMinutes, share });
  };

  // Staff-pool ฿ that couldn't be paid to anyone (an amount recorded on a day no
  // company member worked) — retained by the company so the books reconcile.
  let undistributedStaff = 0;

  for (const date of allDates) {
    // Amounts entered per branch this day.
    const amountByBranch = new Map<number, number>();
    for (const { branch, ctx } of contexts) {
      const a = ctx.amountByDate.get(date) ?? 0;
      if (a > 0) amountByBranch.set(branch.id, a);
    }
    const pooled = [...amountByBranch.values()].reduce((s, a) => s + a, 0);
    if (pooled <= 0) continue;

    // Everyone who worked any branch that day, with 480-cap on their COMBINED day
    // (OT-exempt), scaled proportionally so the per-branch split stays intact.
    const rawUnits: Array<{ userId: number; branchId: number; minutes: number }> = [];
    const combinedByUser = new Map<number, number>();
    for (const { branch, ctx } of contexts) {
      const dayMap = ctx.workedByDay.get(date);
      if (!dayMap) continue;
      for (const [userId, mins] of dayMap) {
        if (mins <= 0) continue;
        if (!memberIdsCompany.has(userId) && !ctx.visitorIds.has(userId)) continue;
        rawUnits.push({ userId, branchId: branch.id, minutes: mins });
        combinedByUser.set(userId, (combinedByUser.get(userId) ?? 0) + mins);
      }
    }
    const scaleByUser = new Map<number, number>();
    for (const [userId, combined] of combinedByUser) {
      scaleByUser.set(userId,
        combined > SVC_MAX_NORMAL_MINUTES && !hasOt(userId, date)
          ? SVC_MAX_NORMAL_MINUTES / combined : 1);
    }
    const units = rawUnits.map((u) => ({ ...u, minutes: u.minutes * (scaleByUser.get(u.userId) ?? 1) }));

    // Stage 1 — split each branch's OWN amount among the people who worked THAT
    // branch that day. A CROSS-COMPANY visitor (member of no branch in this
    // company — e.g. a helper from another company at one branch) keeps only this
    // per-branch share and does NOT draw from the cross-branch pool (owner
    // 2026-08-20: "ควรได้รับแค่ของสาขานั้น"). Company members' per-branch shares are
    // instead collected into the day's pool and re-split in stage 2, so a member
    // who worked a branch with NO amount that day still gets a share.
    const unitsByBranch = new Map<number, Array<{ userId: number; branchId: number; minutes: number }>>();
    for (const u of units) {
      let arr = unitsByBranch.get(u.branchId);
      if (!arr) { arr = []; unitsByBranch.set(u.branchId, arr); }
      arr.push(u);
    }
    let dayMemberPool = 0;
    for (const [branchId, amount] of amountByBranch) {
      const staffPoolB = amount * SVC_STAFF_SHARE_RATIO;
      const bUnits = unitsByBranch.get(branchId) ?? [];
      let totalMinB = 0;
      for (const u of bUnits) totalMinB += u.minutes;
      if (totalMinB <= 0) {
        // Amount recorded but nobody worked THIS branch that day (all transferred
        // out) — its staff share isn't lost: it flows into the company pool and is
        // re-split among the members who worked, so nothing leaks (owner 2026-08-20).
        dayMemberPool += staffPoolB;
        continue;
      }
      for (const u of bUnits) {
        const shareB = staffPoolB * (u.minutes / totalMinB);
        if (memberIdsCompany.has(u.userId)) {
          dayMemberPool += shareB;   // → company pool (re-split in stage 2)
        } else {
          addShare(u.userId, branchId, shareB, u.minutes,
            { date, dayAmount: amount, staffPool: staffPoolB, totalMinutes: totalMinB, userMinutes: u.minutes });
        }
      }
    }

    // Stage 2 — re-split the company pool among MEMBERS who worked that day, by
    // their total hours (any branch, INCLUDING branches with no amount), and
    // attribute each member's slice to the branch(es) they physically worked at.
    const memberUnits = units.filter((u) => memberIdsCompany.has(u.userId));
    let totalMemberMin = 0;
    for (const u of memberUnits) totalMemberMin += u.minutes;
    if (dayMemberPool > 0 && totalMemberMin > 0) {
      for (const u of memberUnits) {
        const share = dayMemberPool * (u.minutes / totalMemberMin);
        addShare(u.userId, u.branchId, share, u.minutes,
          { date, dayAmount: pooled, staffPool: dayMemberPool, totalMinutes: totalMemberMin, userMinutes: u.minutes });
      }
    } else if (dayMemberPool > 0) {
      // No company member worked at all that day — the pool can't be paid to
      // anyone, so it's retained by the company (keeps the books reconciling).
      undistributedStaff += dayMemberPool;
    }
  }

  // Company-level food-credit clawback (owner 2026-08-18): judged against the
  // COMBINED daily minutes above, so a mid-day transfer that adds up to a full
  // shift is not clawed. Early-leave approvals are company-wide per month.
  const earlyLeaveKeys = approvedEarlyLeaveKeys(db, yearMonth);
  const allRedeemedFood = contexts.flatMap(({ ctx }) => ctx.redeemedFood);
  const staffIdsCompany = new Set([...metaByUser.keys()]);
  const clawbackByUser = computeFoodClawbacks(
    allRedeemedFood, combinedWorkedByDay, earlyLeaveKeys, (uid) => staffIdsCompany.has(uid)
  );

  const [yyyy, mm] = yearMonth.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(yyyy, mm, 0)).getUTCDate();
  const fallbackScheduled = daysInMonth * 8 * 60;

  const exemptedSet = listSvcForfeitExemptions(yearMonth);
  const rows: CompanySvcRow[] = [...accByUser.keys()].map((userId) => {
    const a = accByUser.get(userId)!;
    const meta = metaByUser.get(userId);
    // Sum pool-independent inputs across the branches this person touched.
    let lateMinutes = 0, anyComputable = false, realScheduled = 0, resignForfeit = false;
    for (const { ctx } of contexts) {
      const lt = ctx.lateByUser.get(userId);
      if (lt) { lateMinutes += lt.lateMinutes; anyComputable = anyComputable || lt.anyComputable; }
      realScheduled += ctx.rosterScheduledByUser.get(userId) ?? 0;
      if (ctx.forfeitedFromResign.has(userId)) resignForfeit = true;
    }
    const rawFoodClawback = (clawbackByUser.get(userId) ?? []).reduce((s, cd) => s + cd.credit, 0);
    return rollupCompanyRow({
      userId,
      displayName: nameWithPrefix(meta?.titlePrefix ?? null, meta?.displayName ?? String(userId)),
      employmentType: meta?.employmentType ?? null,
      byBranch: [...a.byBranch.values()].sort((x, y) => branchOrder(branches, x.branchId) - branchOrder(branches, y.branchId)),
      breakdown: a.breakdown,
      grossRaw: a.gross, lateMinutes, anyComputable,
      realScheduledMinutes: realScheduled, fallbackScheduled,
      resignForfeit, rawFoodClawback,
      taxMode: meta?.taxMode === "wht" ? "wht" : "sso",
      giStartMonth: meta?.groupInsuranceStartMonth ?? null,
      skipGroupInsurance: !memberIdsCompany.has(userId),
      exempted: exemptedSet.has(userId),
      yearMonth, whtRate
    });
  }).sort((x, y) => y.netPayout - x.netPayout);

  const branchTotals = contexts.map(({ branch, ctx }) => ({
    branchId: branch.id, branchName: branch.name, totalCollected: ctx.totalCollected
  }));
  const totalCollected = branchTotals.reduce((s, b) => s + b.totalCollected, 0);
  return {
    companyId, yearMonth, shared: true,
    branches: branchTotals,
    totalCollected,
    staffPoolTotal: round2(totalCollected * SVC_STAFF_SHARE_RATIO),
    companyPoolTotal: round2(
      totalCollected * SVC_COMPANY_SHARE_RATIO
      + rows.reduce((s, r) => s + (r.forfeited ? r.grossAllocation : 0), 0)
      + rows.reduce((s, r) => s + r.foodClawback, 0)
      + undistributedStaff
    ),
    totalWht: round2(rows.reduce((s, r) => s + r.whtAmount, 0)),
    totalGroupInsurance: round2(rows.reduce((s, r) => s + r.groupInsurance, 0)),
    totalNetPayout: round2(rows.reduce((s, r) => s + r.netPayout, 0)),
    rows,
    payoutDate: computePayoutDate(yearMonth)
  };
}

/** display_order rank of a branch id (for stable byBranch ordering). */
function branchOrder(branches: Array<{ id: number }>, branchId: number): number {
  const i = branches.findIndex((b) => b.id === branchId);
  return i < 0 ? branches.length : i;
}

/** Company-wide SVC summary for a month (owner 2026-08-18). Dispatches to the
 *  "รวมกอง" shared-pool mode when the (company, month) is toggled on; otherwise the
 *  per-branch view (each branch's pool → its own workers, aggregated). Non-shared
 *  mode reuses the tested computeMonthlySvcSummary per branch. */
export function computeCompanySvcSummary(companyId: number, yearMonth: string): CompanySvcSummary {
  if (isSharedSvcMonth(companyId, yearMonth) && !isManualSvcMonth(yearMonth)) {
    return computeCompanySvcSummaryShared(companyId, yearMonth);
  }
  const db = getDb();
  const branches = db.prepare(
    "SELECT id, name FROM branches WHERE company_id = ? ORDER BY display_order, name"
  ).all(companyId) as Array<{ id: number; name: string }>;
  // NOTE (owner 2026-08-18): the "รวมกอง SVC ทั้งบริษัท" shared-pool mode
  // (isSharedSvcMonth) is layered on top as a follow-up. This function is the
  // per-branch company view (each branch's pool → its own workers, aggregated).

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const whtRate = (db.prepare("SELECT wht_rate FROM payroll_settings LIMIT 1")
    .get() as { wht_rate: number } | undefined)?.wht_rate ?? 0.03;

  // Per-branch summaries (reuse the tested engine — the hard daily distribution).
  const perBranch = branches.map((b) => ({ branch: b, summary: computeMonthlySvcSummary(b.id, yearMonth) }));

  type Acc = {
    displayName: string; employmentType: string | null;
    byBranch: CompanySvcBranchShare[];
    gross: number; lateMinutes: number; resignForfeit: boolean; foodClawback: number;
    taxMode: "sso" | "wht";
    breakdown: CompanySvcRow["dailyBreakdown"];
  };
  const accByUser = new Map<number, Acc>();
  for (const { branch, summary } of perBranch) {
    for (const r of summary.rows) {
      let a = accByUser.get(r.userId);
      if (!a) {
        a = { displayName: r.displayName, employmentType: r.employmentType,
              byBranch: [], gross: 0, lateMinutes: 0, resignForfeit: false,
              foodClawback: 0, taxMode: r.taxMode, breakdown: [] };
        accByUser.set(r.userId, a);
      }
      a.byBranch.push({ branchId: branch.id, branchName: branch.name,
        grossAllocation: r.grossAllocation, daysWorked: r.daysWorked, minutesWorked: r.totalMinutesWorked });
      a.gross += r.grossAllocation;
      a.lateMinutes += r.lateMinutes;
      if (r.forfeitReason === "resignation") a.resignForfeit = true;
      a.foodClawback += r.foodClawback;
      for (const bd of r.dailyBreakdown) {
        a.breakdown.push({ ...bd, branchId: branch.id, branchName: branch.name });
      }
    }
  }

  // Real roster minutes across all company branches (owner 2026-08-18): sum each
  // branch's rostered minutes so the late-ratio denominator isn't inflated by a
  // per-branch fallback. Fallback (daysInMonth × 8h) applies ONCE, only if the
  // person has no roster anywhere.
  const [yyyy, mm] = yearMonth.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(yyyy, mm, 0)).getUTCDate();
  const fallbackScheduled = daysInMonth * 8 * 60;
  const userIds = [...accByUser.keys()];
  const rosterMinByUser = new Map<number, number>();
  for (const b of branches) {
    const m = scheduledMinutesByUserForMonth(b.id, yearMonth, userIds);
    for (const [uid, mins] of m) rosterMinByUser.set(uid, (rosterMinByUser.get(uid) ?? 0) + mins);
  }
  // Meta for the single group-insurance recompute + company membership. A person
  // who is a member of NO branch in this company (a cross-company visitor whose
  // punches only appear as transfer-ins) must NOT have the ฿350 GI withheld here —
  // it is taken once at their home company (owner 2026-08-02, mirrored to the
  // company view 2026-08-18).
  const metaByUser = new Map<number, { startMonth: string | null }>();
  const companyMemberIds = new Set<number>();
  if (userIds.length > 0) {
    const ph = userIds.map(() => "?").join(",");
    for (const r of db.prepare(
      `SELECT id, group_insurance_start_month AS sm FROM users WHERE id IN (${ph})`
    ).all(...userIds) as Array<{ id: number; sm: string | null }>) {
      metaByUser.set(r.id, { startMonth: r.sm });
    }
    for (const r of db.prepare(
      `SELECT DISTINCT ub.user_id AS uid FROM user_branches ub
        JOIN branches b ON b.id = ub.branch_id
       WHERE b.company_id = ? AND ub.user_id IN (${ph})`
    ).all(companyId, ...userIds) as Array<{ uid: number }>) {
      companyMemberIds.add(r.uid);
    }
  }

  const exemptedSet = listSvcForfeitExemptions(yearMonth);
  const rows: CompanySvcRow[] = userIds.map((userId) => {
    const a = accByUser.get(userId)!;
    return rollupCompanyRow({
      userId, displayName: a.displayName, employmentType: a.employmentType,
      byBranch: a.byBranch, breakdown: a.breakdown,
      grossRaw: a.gross, lateMinutes: a.lateMinutes, anyComputable: a.lateMinutes > 0,
      realScheduledMinutes: rosterMinByUser.get(userId) ?? 0, fallbackScheduled,
      resignForfeit: a.resignForfeit, rawFoodClawback: a.foodClawback,
      taxMode: a.taxMode,
      giStartMonth: metaByUser.get(userId)?.startMonth ?? null,
      skipGroupInsurance: !companyMemberIds.has(userId),
      exempted: exemptedSet.has(userId),
      yearMonth, whtRate
    });
  }).sort((x, y) => y.netPayout - x.netPayout);

  const branchTotals = perBranch.map(({ branch, summary }) => ({
    branchId: branch.id, branchName: branch.name, totalCollected: summary.totalCollected
  }));
  const totalCollected = branchTotals.reduce((s, b) => s + b.totalCollected, 0);
  return {
    companyId, yearMonth, shared: false,
    branches: branchTotals,
    totalCollected,
    staffPoolTotal: round2(totalCollected * SVC_STAFF_SHARE_RATIO),
    companyPoolTotal: round2(
      totalCollected * SVC_COMPANY_SHARE_RATIO
      + rows.reduce((s, r) => s + (r.forfeited ? r.grossAllocation : 0), 0)
      + rows.reduce((s, r) => s + r.foodClawback, 0)
    ),
    totalWht: round2(rows.reduce((s, r) => s + r.whtAmount, 0)),
    totalGroupInsurance: round2(rows.reduce((s, r) => s + r.groupInsurance, 0)),
    totalNetPayout: round2(rows.reduce((s, r) => s + r.netPayout, 0)),
    rows,
    payoutDate: computePayoutDate(yearMonth)
  };
}

/** Clamped worked minutes for ONE user on ONE day at a branch — the exact same
 *  engine the monthly SVC roll-up uses (pairShifts → roster-clamp → break-deduct
 *  → approved-OT extend). The clock-out food-credit warning calls this so the
 *  advisory it shows matches the clawback the monthly compute will apply. Returns
 *  0 for an abnormal/uncertified or no-shift day (same exclusion rules). */
export function svcWorkedMinutesForUserDate(
  branchId: number, userId: number, dateBkk: string
): number {
  const db = getDb();
  const dayStartIso = new Date(`${dateBkk}T00:00:00+07:00`).toISOString();
  const dayEndIso = new Date(`${dateBkk}T23:59:59+07:00`).toISOString();
  const entries = db.prepare(
    `SELECT user_id, ts, type FROM time_entries
      WHERE branch_id = ? AND user_id = ? AND ts >= ? AND ts <= ?`
  ).all(branchId, userId, dayStartIso, dayEndIso) as
    Array<{ user_id: number; ts: string; type: "in" | "out" }>;
  if (entries.length === 0) return 0;

  const scheduledByUser = buildScheduledByUser(branchId, dateBkk, dateBkk);
  const otByUser = new Map<number, Map<string, string>>();
  const ot = db.prepare(
    "SELECT requested_until FROM ot_requests WHERE status = 'approved' AND user_id = ? AND work_date = ?"
  ).get(userId, dateBkk) as { requested_until: string } | undefined;
  if (ot) { const m = new Map<string, string>(); m.set(dateBkk, ot.requested_until); otByUser.set(userId, m); }

  const brk = (db.prepare(`
    SELECT break_threshold_minutes, break_deduction_minutes,
           long_shift_threshold_minutes, long_shift_break_minutes
    FROM payroll_settings LIMIT 1
  `).get() as BreakSettings | undefined) ?? {
    break_threshold_minutes: 300, break_deduction_minutes: 30,
    long_shift_threshold_minutes: 480, long_shift_break_minutes: 60
  };
  // Mirror the monthly engine: a work shift ANYWHERE that day means a clock-in at
  // this branch with no local roster is a legit transfer, not an excluded
  // no-schedule day (owner 2026-08-02).
  const rosteredSomewhere = new Set<string>();
  const anyShift = db.prepare(`
    SELECT 1 FROM roster_assignments ra
    JOIN shift_codes sc ON sc.id = ra.shift_code_id
    WHERE ra.user_id = ? AND ra.assignment_date = ? AND sc.kind = 'work' LIMIT 1
  `).get(userId, dateBkk);
  if (anyShift) rosteredSomewhere.add(`${userId}:${dateBkk}`);
  // FT lateness doesn't dock SVC minutes (owner 2026-08-03) — mirror the monthly engine.
  const empRow = db.prepare("SELECT employment_type FROM users WHERE id = ?").get(userId) as
    { employment_type: string | null } | undefined;
  const ftUserIds = empRow?.employment_type === "ft" ? new Set<number>([userId]) : new Set<number>();
  const workedByDay = computeSvcClampedMinutesByDay(
    entries, scheduledByUser, otByUser, brk, true, true, rosteredSomewhere, ftUserIds, new Map()
  );
  return workedByDay.get(dateBkk)?.get(userId) ?? 0;
}

/** Empty summary helper — keeps the type stable when a branch has
 *  no staff or no daily entries yet. */
function emptySummary(
  branchId: number, yearMonth: string,
  totalCollected: number, daysInMonth: number, daysWithEntries: number
): MonthlySvcSummary {
  return {
    branchId, yearMonth, totalCollected,
    staffPoolTotal: totalCollected * SVC_STAFF_SHARE_RATIO,
    companyPoolFromSplit: totalCollected * SVC_COMPANY_SHARE_RATIO,
    companyPoolFromForfeit: 0,
    companyPoolFromClawback: 0,
    companyPoolTotal: totalCollected * SVC_COMPANY_SHARE_RATIO,
    totalWht: 0,
    totalGroupInsurance: 0,
    totalNetPayout: 0,
    rows: [],
    daysWithEntries,
    daysInMonth,
    payoutDate: computePayoutDate(yearMonth),
    manualEntry: false
  };
}

/** Manual (pre-system) monthly summary — the per-staff GROSS is TYPED by hand
 *  (svc_manual_allocations), not computed from clock/roster data (owner
 *  2026-07-21). WHT is still withheld for 'wht' staff and the rows post to
 *  ACCOUNTA exactly like a normal month (postSvcToAccounta reads this).
 *
 *  Roster: the current active SVC-eligible staff at the branch, PLUS anyone who
 *  already has a manual amount for the month (so a person who has since resigned
 *  still shows and still pays out on a historical month). No forfeiture, no late
 *  ratio, no daily breakdown — none of that data exists pre-system. */
function computeManualSvcSummary(branchId: number, yearMonth: string): MonthlySvcSummary {
  const db = getDb();
  const end = `${yearMonth}-31`;
  const [yyyy, mm] = yearMonth.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(yyyy, mm, 0)).getUTCDate();

  const staff = db.prepare(`
    SELECT u.id AS userId, u.display_name AS displayName,
           u.employment_type AS employmentType,
           u.shift_start_time AS shiftStartTime,
           u.weekly_off_days AS weeklyOffDays,
           COALESCE(u.track_attendance, 1) AS trackAttendance,
           u.salary_tax_mode AS taxMode,
           u.title_prefix AS titlePrefix,
           u.employee_code AS employeeCode,
           u.hire_date AS hireDate,
           u.group_insurance_start_month AS groupInsuranceStartMonth
    FROM users u
    JOIN user_branches ub ON ub.user_id = u.id
    WHERE ub.branch_id = ? AND u.role IN ('staff', 'admin')
      AND u.is_test_account = 0
      AND (
        (u.receives_service_charge = 1
          AND u.status NOT IN ('disabled', 'resigned', 'terminated')
          AND (u.hire_date IS NULL OR u.hire_date <= ?))
        OR u.id IN (SELECT user_id FROM svc_manual_allocations WHERE branch_id = ? AND year_month = ?)
      )
    ORDER BY (u.employee_code IS NULL), u.employee_code COLLATE NOCASE ASC
  `).all(branchId, end, branchId, yearMonth) as StaffMeta[];

  const gross = listManualAllocations(branchId, yearMonth);
  const whtRate = (db.prepare("SELECT wht_rate FROM payroll_settings LIMIT 1")
    .get() as { wht_rate: number } | undefined)?.wht_rate ?? 0.03;
  const round2 = (n: number) => Math.round(n * 100) / 100;

  const rows: MonthlySvcRow[] = staff.map((s) => {
    const g = round2(gross.get(s.userId) ?? 0);
    const taxMode: "sso" | "wht" = s.taxMode === "wht" ? "wht" : "sso";
    const whtAmount = taxMode === "wht" ? round2(g * whtRate) : 0;
    const netPayout = round2(g - whtAmount);
    return {
      userId: s.userId,
      displayName: nameWithPrefix(s.titlePrefix, s.displayName),
      employmentType: s.employmentType,
      shiftStartTime: s.shiftStartTime,
      totalMinutesWorked: 0,
      daysWorked: 0,
      scheduledMinutes: 0,
      lateMinutes: 0,
      lateRatio: 0,
      grossAllocation: g,
      forfeited: false,
      forfeitReason: null,
      exempted: false,
      exemptReason: null,
      netAllocation: g,
      taxMode,
      whtAmount,
      groupInsurance: 0, // pre-system months predate the group-insurance rule
      netPayout,
      dailyBreakdown: [],
      excludedDays: [],
      foodClawback: 0,
      foodClawbackDays: []
    };
  });

  const staffPoolTotal = round2(rows.reduce((s, r) => s + r.grossAllocation, 0));
  const totalWht = round2(rows.reduce((s, r) => s + r.whtAmount, 0));
  const totalNetPayout = round2(rows.reduce((s, r) => s + r.netPayout, 0));

  return {
    branchId,
    yearMonth,
    // No POS total recorded pre-system — the entered amounts ARE the staff share.
    // Company pool / 60-40 split don't apply; the page renders manual-specific cards.
    totalCollected: staffPoolTotal,
    staffPoolTotal,
    companyPoolFromSplit: 0,
    companyPoolFromForfeit: 0,
    companyPoolFromClawback: 0,
    companyPoolTotal: 0,
    totalWht,
    totalGroupInsurance: 0,
    totalNetPayout,
    rows,
    daysWithEntries: 0,
    daysInMonth,
    payoutDate: computePayoutDate(yearMonth),
    manualEntry: true
  };
}

/** Compute the payout date for a given accrual month — the 20th of
 *  the following calendar month. Returns YYYY-MM-DD. */
export function computePayoutDate(yearMonth: string): string {
  const [yyyy, mm] = yearMonth.split("-").map(Number);
  const nextY = mm === 12 ? yyyy + 1 : yyyy;
  const nextM = mm === 12 ? 1 : mm + 1;
  return `${nextY}-${String(nextM).padStart(2, "0")}-20`;
}

function hhmmToMin(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}
