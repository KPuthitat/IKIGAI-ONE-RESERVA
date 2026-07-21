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
import { LATE_GRACE_MINUTES, SC_INELIGIBILITY_THRESHOLD } from "./late-detection";
import {
  shiftStartByDateForUserMonth,
  scheduledMinutesByUserForMonth
} from "./roster";

export const SVC_STAFF_SHARE_RATIO = 0.6;  // 3 of 5 parts
export const SVC_COMPANY_SHARE_RATIO = 0.4; // 2 of 5 parts

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
  netAllocation: number;     // 0 if forfeited; else grossAllocation (pre-WHT)
  // Withholding tax on the SVC payout, mirroring payroll (owner 2026-07-21):
  // 'wht' staff have 3% withheld, 'sso' staff receive the full net.
  taxMode: "sso" | "wht";
  whtAmount: number;         // netAllocation × wht_rate when taxMode==='wht', else 0
  netPayout: number;         // netAllocation − whtAmount (the amount actually paid)
  // แจกแจงรายวันว่าส่วนแบ่งมาจากไหน (owner 2026-07-20 — ปุ่ม "วิธีคำนวณ").
  // share = dayAmount × 60% × (userMinutes ÷ totalMinutes). ผลรวม share = grossAllocation.
  dailyBreakdown: Array<{
    date: string; dayAmount: number; staffPool: number;
    userMinutes: number; totalMinutes: number; share: number;
  }>;
};

export type MonthlySvcSummary = {
  branchId: number;
  yearMonth: string;         // YYYY-MM
  totalCollected: number;    // sum of daily amount_baht
  staffPoolTotal: number;    // 60% of totalCollected
  companyPoolFromSplit: number; // 40% (always)
  companyPoolFromForfeit: number; // additional from forfeitures
  companyPoolTotal: number;  // sum of above two
  totalWht: number;          // sum of per-staff WHT withheld from SVC
  totalNetPayout: number;    // sum of per-staff netPayout (after forfeit + WHT)
  rows: MonthlySvcRow[];
  daysWithEntries: number;   // for UX: how many days admin has filled
  daysInMonth: number;
  payoutDate: string;        // YYYY-MM-20 of the following month
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
 *  หักเบรก, ไม่รวม OT). Reuses applyPtGrace/pickScheduled so SVC time matches
 *  the paid time in ค่าตอบแทน.
 *
 *  Break handling (owner 2026-07-21): when the shift has a scheduled break
 *  window, applyPtGrace already deducts it. When it does NOT — an unrostered
 *  clock-in, or a shift_code with no break defined — apply the same
 *  threshold-based break as payroll's deductBreak, so a long shift never counts
 *  the break as worked (a staffer who clocks in at the break start no longer
 *  collects the whole break as share). */
function computeSvcClampedMinutesByDay(
  entries: Array<{ user_id: number; ts: string; type: "in" | "out" }>,
  scheduledByUser: Map<number, Map<string, ScheduledShift[]>>,
  brk: BreakSettings
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
      const { shifts } = pairShifts(list);
      const candidates = scheduledByUser.get(userId)?.get(date) ?? [];
      let total = 0;
      for (const sh of shifts) {
        const sched = candidates.length ? pickScheduled(candidates, sh) : null;
        const g = applyPtGrace({ startTs: sh.startTs, endTs: sh.endTs }, sched, null);
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
           u.employee_code AS employeeCode
    FROM users u
    JOIN user_branches ub ON ub.user_id = u.id
    WHERE ub.branch_id = ? AND u.role IN ('staff', 'admin')
      AND u.receives_service_charge = 1
      AND u.is_test_account = 0
      AND u.status NOT IN ('disabled', 'resigned', 'terminated')
      AND (u.hire_date IS NULL OR u.hire_date <= ?)
    ORDER BY (u.employee_code IS NULL), u.employee_code COLLATE NOCASE ASC
  `).all(branchId, end) as StaffMeta[];
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
  const workedByDay = computeSvcClampedMinutesByDay(entries, scheduledByUser, brk);

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
    const rosterShiftByDate = shiftStartByDateForUserMonth(branchId, s.userId, yearMonth);
    const rosterMin = rosterScheduledByUser.get(s.userId) ?? 0;
    const scheduledMinutes = rosterMin > 0 ? rosterMin : fallbackScheduledMinutes;

    // Lateness — per-event: look up effective shift start from roster
    // first, then fall back to the static users.shift_start_time. If
    // neither exists for a given event, that event simply isn't
    // counted as late (no scheduled shift = no expectation).
    let lateMinutes = 0;
    let anyComputable = false;
    for (const ev of (insByUser.get(s.userId) ?? [])) {
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
    const forfeited = lateForfeit || resignForfeit;
    // Name: mirror payroll — carry display_name + title_prefix and compose with
    // nameWithPrefix (owner 2026-07-21: ใช้วิธีเดียวกับหน้าค่าตอบแทน). Staff with a
    // title_prefix show it; staff with none show display_name as-is (owner fills
    // the คำนำหน้า in the employee editor — the system does not guess).
    const displayName = nameWithPrefix(s.titlePrefix, s.displayName);
    // WHT: 'wht' staff have 3% withheld from their SVC payout; 'sso' staff get
    // the full net (owner 2026-07-21). Applied after forfeiture (forfeited = 0).
    const netAllocation = forfeited ? 0 : a.grossAllocation;
    const taxMode: "sso" | "wht" = s.taxMode === "wht" ? "wht" : "sso";
    const whtAmount = taxMode === "wht" ? round2(netAllocation * whtRate) : 0;
    const netPayout = round2(netAllocation - whtAmount);
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
      forfeitReason: forfeited
        ? (resignForfeit ? "resignation" : "late_20pct")
        : null,
      netAllocation,
      taxMode,
      whtAmount,
      netPayout,
      dailyBreakdown: breakdownByUser.get(s.userId) ?? []
    };
  });

  // 10. Company pool totals
  const staffPoolTotal = totalCollected * SVC_STAFF_SHARE_RATIO;
  const companyFromSplit = totalCollected * SVC_COMPANY_SHARE_RATIO;
  const companyFromForfeit = rows.reduce(
    (s, r) => s + (r.forfeited ? r.grossAllocation : 0), 0
  );
  const totalWht = rows.reduce((s, r) => s + r.whtAmount, 0);
  const totalNetPayout = rows.reduce((s, r) => s + r.netPayout, 0);

  return {
    branchId,
    yearMonth,
    totalCollected,
    staffPoolTotal,
    companyPoolFromSplit: companyFromSplit,
    companyPoolFromForfeit: companyFromForfeit,
    companyPoolTotal: companyFromSplit + companyFromForfeit,
    totalWht,
    totalNetPayout,
    rows,
    daysWithEntries: dailyRows.length,
    daysInMonth,
    payoutDate: computePayoutDate(yearMonth)
  };
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
    companyPoolTotal: totalCollected * SVC_COMPANY_SHARE_RATIO,
    totalWht: 0,
    totalNetPayout: 0,
    rows: [],
    daysWithEntries,
    daysInMonth,
    payoutDate: computePayoutDate(yearMonth)
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
