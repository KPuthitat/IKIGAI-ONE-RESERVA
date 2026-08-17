// Daily attendance roll-call (TC-6).
//
// Replaces the per-clock-event "who's in / who's not" Flex (which fired
// once per clock-in and spammed the staff group) with a single
// categorized summary that fires once per day per branch, at the
// admin-configured `branches.attendance_summary_time` (recommended:
// shift_start + 1 hour). The summary routes to the IKIGAI OS global
// executive group via notifyToStaffGroup() so all branches surface in
// one chat.
//
// Categorization rules:
//   • มาตรงเวลา (on time)   — first clock-in today exists AND
//                              (no shift_start_time set OR
//                               minutes-late ≤ 5 = within grace).
//   • มาสาย (late)         — first clock-in today exists AND
//                              minutes-late > 5.
//   • ลางาน (on leave)      — no clock-in AND an approved leave_request
//                              whose date_from..date_to range covers today.
//   • ขาดงาน (absent)        — no clock-in AND no approved leave.
//
// "Today" is always Bangkok-local. Lateness uses computeLateness() from
// late-detection.ts so the same 5-minute grace constant powers both
// this view and the monthly summary.

import { getDb, type Branch } from "./db";
import { computeLateness } from "./late-detection";
import { effectiveShiftStartByUserForDate } from "./roster";

export type AttendanceCategory =
  | "on_time"
  | "late"
  | "on_leave"
  | "absent"
  | "not_yet";   // shift today but start time hasn't arrived yet (2026-05)

export type DailySummaryRow = {
  userId: number;
  displayName: string;
  titlePrefix: string | null;   // 2026-05: include the คุณ/พี่/ฯ prefix
  category: AttendanceCategory;
  inTs: string | null;          // ISO of first clock-in (null for leave/absent)
  minutesLate: number;          // 0 for on_time/on_leave/absent
  leaveType: string | null;     // e.g. 'sick','personal'; null unless on_leave
};

/** Build today's categorized roster for a branch. Reads:
 *    1. All staff assigned to the branch via user_branches
 *    2. Their first clock-in event in today's Bangkok window
 *    3. Approved leave_requests overlapping today
 *  Returns one row per staff member with a category + supporting data.
 *
 *  `nowMs` defaults to Date.now() and feeds the "not_yet" bucket —
 *  staff whose shift starts later today (e.g., 13:00 shift) and the
 *  summary fires earlier (e.g., 11:00 cron tick) shouldn't be marked
 *  absent. Pass an explicit nowMs for deterministic tests / when the
 *  caller wants the summary "as of HH:MM" rather than the wall clock. */
export function buildDailyAttendanceRoster(
  branchId: number,
  dateBkk: string,
  nowMs: number = Date.now()
): DailySummaryRow[] {
  const db = getDb();
  const startIso = new Date(`${dateBkk}T00:00:00+07:00`).toISOString();
  const endIso = new Date(`${dateBkk}T23:59:59+07:00`).toISOString();

  // 1) Staff roster for the branch — owner direction 2026-05:
  //    - include admin role (admins are employees too)
  //    - skip status != 'active' (disabled / pending invites)
  //    - skip test accounts (username starting with 'test')
  //    - skip track_attendance = 0 (owner 2026-08-17): salaried
  //      exec/admin who don't clock in must not appear in the roll-call
  //      at all — no notification, never counted absent.
  //    - include title_prefix so the LINE card shows e.g.
  //      "คุณ A" instead of bare "A"
  type RosterRow = {
    user_id: number;
    display_name: string;
    title_prefix: string | null;
    shift_start_time: string | null;
  };
  const staff = db.prepare(`
    SELECT u.id AS user_id,
           u.display_name,
           u.title_prefix,
           u.shift_start_time
    FROM users u
    JOIN user_branches ub ON ub.user_id = u.id
    WHERE ub.branch_id = ?
      AND u.role IN ('staff', 'admin')
      AND u.status = 'active'
      AND u.is_test_account = 0
      AND u.track_attendance = 1
    ORDER BY u.display_name COLLATE NOCASE ASC
  `).all(branchId) as RosterRow[];
  if (staff.length === 0) return [];

  const staffIds = staff.map((s) => s.user_id);
  const placeholders = staffIds.map(() => "?").join(",");

  // 2) First clock-in per staff today
  type InRow = { user_id: number; ts: string };
  const inRows = db.prepare(`
    SELECT user_id, MIN(ts) AS ts
    FROM time_entries
    WHERE branch_id = ?
      AND type = 'in'
      AND ts >= ? AND ts <= ?
      AND user_id IN (${placeholders})
    GROUP BY user_id
  `).all(branchId, startIso, endIso, ...staffIds) as InRow[];
  const inByUser = new Map<number, string>();
  for (const r of inRows) inByUser.set(r.user_id, r.ts);

  // 3) Leave covering today (date_from..date_to inclusive). Include
  //    PENDING as well as approved (owner 2026-06-08, item 7): a filed
  //    leave must read as "ลางาน", never "ขาดงาน", even before the owner
  //    approves it. (Approved sorts last so its type wins on overwrite.)
  type LeaveRow = { user_id: number; type: string };
  const leaveRows = db.prepare(`
    SELECT user_id, type
    FROM leave_requests
    WHERE status IN ('pending', 'approved')
      AND date_from <= ?
      AND date_to >= ?
      AND user_id IN (${placeholders})
    ORDER BY (status = 'approved')
  `).all(dateBkk, dateBkk, ...staffIds) as LeaveRow[];
  const leaveByUser = new Map<number, string>();
  for (const r of leaveRows) leaveByUser.set(r.user_id, r.type);

  // 3b) Scheduled day-off via the roster (owner 2026-06-08). A day_off
  //     assignment must NOT read as absent even when the user still has a
  //     legacy users.shift_start_time (which would otherwise make
  //     effectiveStart truthy → fall through to the absent bucket).
  type DayOffRow = { user_id: number };
  const dayOffRows = db.prepare(`
    SELECT DISTINCT ra.user_id
    FROM roster_assignments ra
    JOIN shift_codes sc ON sc.id = ra.shift_code_id
    WHERE ra.branch_id = ? AND ra.assignment_date = ? AND sc.kind = 'day_off'
      AND ra.user_id IN (${placeholders})
  `).all(branchId, dateBkk, ...staffIds) as DayOffRow[];
  const dayOffSet = new Set(dayOffRows.map((r) => r.user_id));

  // Roster overlay — when the supervisor has assigned shifts for
  // today, the roster's start time wins over users.shift_start_time
  // (which becomes a legacy fallback for staff still on the old
  // per-user static schedule).
  const rosterShiftByUser = effectiveShiftStartByUserForDate(branchId, dateBkk, staffIds);

  // Bangkok-local current time as "HH:MM" string. Lexicographic
  // string compare is safe on zero-padded times, same trick the
  // rest of the codebase uses for isDailySummaryDue.
  const nowHhmmBkk = new Date(nowMs + 7 * 60 * 60 * 1000)
    .toISOString().slice(11, 16);

  // 4) Bucket each staff member. Owner direction 2026-05: if a user
  //    has NO shift today (no roster assignment AND no legacy
  //    shift_start_time AND no approved leave covering today), it's
  //    their weekly off day — skip them from the summary so the list
  //    stays focused on people who were supposed to be at work.
  //    Approved leave still surfaces so admins know the off day was
  //    pre-approved time off rather than a no-shift gap.
  return staff.flatMap((s): DailySummaryRow[] => {
    const inTs = inByUser.get(s.user_id) ?? null;
    const leaveType = leaveByUser.get(s.user_id) ?? null;
    const rosterStart = rosterShiftByUser.get(s.user_id) ?? null;
    const effectiveStart = rosterStart ?? s.shift_start_time;
    // Skip people with no shift today AND no leave — they're on
    // their weekly off, no need to clutter the roster.
    if (!inTs && !leaveType && !effectiveStart) return [];
    if (inTs) {
      const r = computeLateness(inTs, effectiveStart);
      if (r.computable && r.isLate) {
        return [{
          userId: s.user_id,
          displayName: s.display_name,
          titlePrefix: s.title_prefix,
          category: "late" as const,
          inTs,
          minutesLate: r.minutesLate,
          leaveType: null
        }];
      }
      return [{
        userId: s.user_id,
        displayName: s.display_name,
        titlePrefix: s.title_prefix,
        category: "on_time" as const,
        inTs,
        minutesLate: 0,
        leaveType: null
      }];
    }
    // No clock-in — leave overrides absent
    if (leaveType) {
      return [{
        userId: s.user_id,
        displayName: s.display_name,
        titlePrefix: s.title_prefix,
        category: "on_leave" as const,
        inTs: null,
        minutesLate: 0,
        leaveType
      }];
    }
    // No clock-in, no leave — a roster-scheduled day off is NOT absent
    // (owner 2026-06-08). Skip like the no-shift case so the roll-call
    // stays focused on people who were supposed to be at work.
    if (dayOffSet.has(s.user_id)) return [];
    // Split remaining into "not_yet" vs "absent" by comparing now with
    // their shift start. Staff whose shift starts later today shouldn't
    // read as absent on the 11:00 summary.
    if (effectiveStart && nowHhmmBkk < effectiveStart) {
      return [{
        userId: s.user_id,
        displayName: s.display_name,
        titlePrefix: s.title_prefix,
        category: "not_yet" as const,
        inTs: null,
        minutesLate: 0,
        leaveType: null
      }];
    }
    return [{
      userId: s.user_id,
      displayName: s.display_name,
      titlePrefix: s.title_prefix,
      category: "absent" as const,
      inTs: null,
      minutesLate: 0,
      leaveType: null
    }];
  });
}

/** Mark a branch as having sent today's summary (legacy single-time
 *  path). Caller passes the YYYY-MM-DD that was actually summarized. */
export function markDailySummarySent(
  branchId: number,
  dateBkk: string
): void {
  getDb().prepare(
    "UPDATE branches SET attendance_summary_last_sent_date = ? WHERE id = ?"
  ).run(dateBkk, branchId);
}

/** Decide whether a branch is due for its daily summary right now
 *  (legacy single-time path — kept for backwards compat; the cron now
 *  uses getAttendanceSummaryDueTimes which supports multiple times). */
export function isDailySummaryDue(
  branch: Branch,
  nowHhmmBkk: string,
  todayBkk: string
): boolean {
  // If the new multi-time column is set, defer to getAttendanceSummaryDueTimes.
  if (branch.attendance_summary_times_json) {
    return getAttendanceSummaryDueTimes(branch, nowHhmmBkk, todayBkk).length > 0;
  }
  const summaryTime = branch.attendance_summary_time;
  if (!summaryTime || !summaryTime.trim()) return false;
  if (branch.attendance_summary_last_sent_date === todayBkk) return false;
  if (nowHhmmBkk < summaryTime) return false;
  return true;
}

// ── Multiple daily attendance summary times (owner 2026-06-06) ────────
// Admin configures 1-3 send times per branch (e.g., "08:30,17:00").
// Attendance summaries route to the HR group (recruita_exec_group_id).

/** Parse the configured send times for a branch.
 *  Prefers the new times_json column; falls back to the legacy single
 *  time field so existing branches keep working without a re-save. */
export function getAttendanceSummaryTimes(branch: Branch): string[] {
  if (branch.attendance_summary_times_json?.trim()) {
    try {
      const arr = JSON.parse(branch.attendance_summary_times_json) as unknown;
      if (Array.isArray(arr)) return (arr as string[]).filter((t) => /^\d{2}:\d{2}$/.test(t));
    } catch { /* fall through */ }
  }
  // Legacy: single time stored in attendance_summary_time
  const t = branch.attendance_summary_time?.trim();
  return t ? [t] : [];
}

/** Which of the configured times are due right now (>= now, not yet
 *  sent today). Returns an array of due time strings (may be empty). */
export function getAttendanceSummaryDueTimes(
  branch: Branch,
  nowHhmmBkk: string,
  todayBkk: string
): string[] {
  const times = getAttendanceSummaryTimes(branch);
  if (times.length === 0) return [];

  // Parse the sent log for today
  let sentToday: string[] = [];
  if (branch.attendance_summary_sent_log) {
    try {
      const log = JSON.parse(branch.attendance_summary_sent_log) as { date?: string; sent?: string[] };
      if (log.date === todayBkk && Array.isArray(log.sent)) {
        sentToday = log.sent;
      }
    } catch { /* ignore corrupt log */ }
  }
  // Also check the legacy last_sent_date for the single-time path
  if (branch.attendance_summary_last_sent_date === todayBkk && times.length === 1) {
    return []; // legacy path already sent today
  }
  return times.filter((t) => nowHhmmBkk >= t && !sentToday.includes(t));
}

/** Mark a specific time slot as sent today.
 *  Updates the JSON sent log on the branch row. */
export function markAttendanceSummarySentTime(
  branchId: number,
  dateBkk: string,
  timeSent: string
): void {
  const db = getDb();
  const row = db.prepare("SELECT attendance_summary_sent_log FROM branches WHERE id = ?")
    .get(branchId) as { attendance_summary_sent_log: string | null } | undefined;
  let log: { date: string; sent: string[] } = { date: dateBkk, sent: [] };
  if (row?.attendance_summary_sent_log) {
    try {
      const prev = JSON.parse(row.attendance_summary_sent_log) as { date?: string; sent?: string[] };
      if (prev.date === dateBkk && Array.isArray(prev.sent)) {
        log = { date: dateBkk, sent: prev.sent };
      }
    } catch { /* reset on corrupt */ }
  }
  if (!log.sent.includes(timeSent)) log.sent.push(timeSent);
  db.prepare(
    "UPDATE branches SET attendance_summary_sent_log = ?, attendance_summary_last_sent_date = ? WHERE id = ?"
  ).run(JSON.stringify(log), dateBkk, branchId);
}
