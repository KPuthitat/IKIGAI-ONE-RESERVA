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

export type AttendanceCategory = "on_time" | "late" | "on_leave" | "absent";

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
 *  Returns one row per staff member with a category + supporting data. */
export function buildDailyAttendanceRoster(
  branchId: number,
  dateBkk: string
): DailySummaryRow[] {
  const db = getDb();
  const startIso = new Date(`${dateBkk}T00:00:00+07:00`).toISOString();
  const endIso = new Date(`${dateBkk}T23:59:59+07:00`).toISOString();

  // 1) Staff roster for the branch — owner direction 2026-05:
  //    - include admin role (admins are employees too)
  //    - skip status != 'active' (disabled / pending invites)
  //    - skip test accounts (username starting with 'test')
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
      AND (u.username IS NULL OR LOWER(u.username) NOT LIKE 'test%')
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

  // 3) Approved leave covering today (date_from..date_to inclusive)
  type LeaveRow = { user_id: number; type: string };
  const leaveRows = db.prepare(`
    SELECT user_id, type
    FROM leave_requests
    WHERE status = 'approved'
      AND date_from <= ?
      AND date_to >= ?
      AND user_id IN (${placeholders})
  `).all(dateBkk, dateBkk, ...staffIds) as LeaveRow[];
  const leaveByUser = new Map<number, string>();
  for (const r of leaveRows) leaveByUser.set(r.user_id, r.type);

  // Roster overlay — when the supervisor has assigned shifts for
  // today, the roster's start time wins over users.shift_start_time
  // (which becomes a legacy fallback for staff still on the old
  // per-user static schedule).
  const rosterShiftByUser = effectiveShiftStartByUserForDate(branchId, dateBkk, staffIds);

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

/** Mark a branch as having sent today's summary so the next cron tick
 *  the same day is a no-op. Caller passes the YYYY-MM-DD that was
 *  actually summarized. */
export function markDailySummarySent(
  branchId: number,
  dateBkk: string
): void {
  getDb().prepare(
    "UPDATE branches SET attendance_summary_last_sent_date = ? WHERE id = ?"
  ).run(dateBkk, branchId);
}

/** Decide whether a branch is due for its daily summary right now.
 *  Pure function — caller pipes in the branch row + current Bangkok
 *  HH:MM + Bangkok date so unit tests don't need to mock the clock.
 *
 *    branch.attendance_summary_time NULL → feature disabled, never due.
 *    last_sent_date == today                → already sent today, skip.
 *    now_hhmm < summary_time                → not time yet.
 *    otherwise                              → due. */
export function isDailySummaryDue(
  branch: Branch,
  nowHhmmBkk: string,
  todayBkk: string
): boolean {
  const summaryTime = branch.attendance_summary_time;
  if (!summaryTime || !summaryTime.trim()) return false;
  if (branch.attendance_summary_last_sent_date === todayBkk) return false;
  // Lexicographic string compare works on zero-padded HH:MM.
  if (nowHhmmBkk < summaryTime) return false;
  return true;
}
