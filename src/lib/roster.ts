// Roster (TC-R) — supervisor assigns monthly shifts to staff.
//
// The data model is a sparse matrix:
//   rows    = positions configured for the branch (CHECKER, SAUTE, ...)
//   columns = calendar days of the selected month
//   cells   = a roster_assignments row (user × shift_code) or empty
//
// On the staff side this matrix is pivoted into a per-user calendar so
// each staff sees "what am I doing today" without scanning the grid.
//
// Effective-shift lookup is the integration seam: late-detection,
// service-charge eligibility, and the daily attendance summary all
// call effectiveShiftStartForUserDate(...) instead of reading
// users.shift_start_time directly. Falls back to the static
// shift_start_time when no roster row exists, so behaviour is
// unchanged for branches that haven't filled in a roster yet.

import { getDb } from "./db";
import type {
  ShiftCode,
  RosterPosition,
  RosterAssignment
} from "./db";
import { computeLateness, SC_INELIGIBILITY_THRESHOLD } from "./late-detection";

export type AssignmentWithJoins = RosterAssignment & {
  position_title: string;
  user_display_name: string;
  user_first_name: string | null;
  user_last_name: string | null;
  user_id_normal: number;
  shift_code: string;
  shift_color: string | null;
  shift_start_time: string;   // HH:MM
  shift_end_time: string;     // HH:MM
  shift_break_start: string | null;
  shift_break_end: string | null;
};

/** Staff-calendar variant — same fields as AssignmentWithJoins plus the
 *  position's free-text description. Kept as a separate exported type
 *  so the staff page can declare it explicitly (Next.js' TS compiler
 *  was losing the inline intersection across module boundaries). */
export type AssignmentForStaffCalendar = AssignmentWithJoins & {
  position_description: string | null;
};

// ── Reads ────────────────────────────────────────────────────────

export function listShiftCodes(branchId: number): ShiftCode[] {
  return getDb().prepare(
    `SELECT * FROM shift_codes WHERE branch_id = ? AND active = 1
     ORDER BY display_order ASC, id ASC`
  ).all(branchId) as ShiftCode[];
}

export function listPositions(branchId: number): RosterPosition[] {
  return getDb().prepare(
    `SELECT * FROM roster_positions WHERE branch_id = ? AND active = 1
     ORDER BY display_order ASC, id ASC`
  ).all(branchId) as RosterPosition[];
}

/** Like listPositions but includes hidden (active=0) rows too — used
 *  by the admin position-settings page where the visibility switch
 *  needs to render inactive positions so admin can flip them back on. */
export function listAllPositions(branchId: number): RosterPosition[] {
  return getDb().prepare(
    `SELECT * FROM roster_positions WHERE branch_id = ?
     ORDER BY active DESC, display_order ASC, id ASC`
  ).all(branchId) as RosterPosition[];
}

/** All assignments in a given Bangkok-month for a branch, joined with
 *  user + shift_code + position labels so the caller can render the
 *  grid in one pass. Returned ordered by (date, position display) for
 *  cheap per-day grouping in JS. */
export function listAssignmentsForMonth(
  branchId: number,
  yearMonth: string
): AssignmentWithJoins[] {
  const start = `${yearMonth}-01`;
  const end = `${yearMonth}-31`;
  return getDb().prepare(`
    SELECT a.*,
           p.title AS position_title,
           p.display_order AS position_display_order,
           u.id AS user_id_normal,
           u.display_name AS user_display_name,
           u.first_name_th AS user_first_name,
           u.last_name_th AS user_last_name,
           s.code AS shift_code,
           s.color AS shift_color,
           s.start_time AS shift_start_time,
           s.end_time AS shift_end_time,
           s.break_start AS shift_break_start,
           s.break_end AS shift_break_end
    FROM roster_assignments a
    JOIN roster_positions p ON p.id = a.position_id
    JOIN users u           ON u.id = a.user_id
    JOIN shift_codes s     ON s.id = a.shift_code_id
    WHERE a.branch_id = ?
      AND a.assignment_date >= ? AND a.assignment_date <= ?
    ORDER BY a.assignment_date ASC, p.display_order ASC
  `).all(branchId, start, end) as AssignmentWithJoins[];
}

/** Pull a single user's assignments for a Bangkok-month — used by the
 *  staff calendar so we don't ship the entire branch roster down. */
export function listAssignmentsForUserMonth(
  userId: number,
  branchId: number,
  yearMonth: string
): AssignmentForStaffCalendar[] {
  const start = `${yearMonth}-01`;
  const end = `${yearMonth}-31`;
  return getDb().prepare(`
    SELECT a.*,
           p.title AS position_title,
           u.id AS user_id_normal,
           u.display_name AS user_display_name,
           u.first_name_th AS user_first_name,
           u.last_name_th AS user_last_name,
           s.code AS shift_code,
           s.color AS shift_color,
           s.start_time AS shift_start_time,
           s.end_time AS shift_end_time,
           s.break_start AS shift_break_start,
           s.break_end AS shift_break_end,
           p.description AS position_description
    FROM roster_assignments a
    JOIN roster_positions p ON p.id = a.position_id
    JOIN users u           ON u.id = a.user_id
    JOIN shift_codes s     ON s.id = a.shift_code_id
    WHERE a.branch_id = ?
      AND a.user_id = ?
      AND a.assignment_date >= ? AND a.assignment_date <= ?
    ORDER BY a.assignment_date ASC, p.display_order ASC
  `).all(branchId, userId, start, end) as AssignmentForStaffCalendar[];
}

/** The single most-recent publish-log entry for a branch+month.
 *  Drives the "ตารางพร้อมแล้ว" banner the staff calendar shows.
 *  Returns null when admin hasn't published the month yet. */
export function getLastPublish(
  branchId: number, yearMonth: string
): { id: number; kind: "publish" | "edit"; published_at: string; published_by: number | null; note: string | null } | null {
  const row = getDb().prepare(`
    SELECT id, kind, published_at, published_by, note
    FROM roster_publish_log
    WHERE branch_id = ? AND year_month = ?
    ORDER BY id DESC LIMIT 1
  `).get(branchId, yearMonth) as
    | { id: number; kind: "publish" | "edit"; published_at: string; published_by: number | null; note: string | null }
    | undefined;
  return row ?? null;
}

// ── Effective shift lookup — the integration seam ────────────────

/** What time should the staff have started work today, per the
 *  roster? Returns "HH:MM" Bangkok local of the roster shift's
 *  start_time, or null when the staff has no roster assignment that
 *  day (treat as a day off — no late check).
 *
 *  Callers that need backward compatibility should fall back to
 *  users.shift_start_time when this returns null AND they want the
 *  legacy behaviour. The conservative rule baked into late-detection
 *  is: no roster + no static start = no lateness check.
 *
 *  When a staff is in multiple positions on the same day (allowed),
 *  the earliest start_time wins — they had to be in by then. */
export function effectiveShiftStartForUserDate(
  userId: number,
  branchId: number,
  dateBkk: string
): string | null {
  const row = getDb().prepare(`
    SELECT MIN(s.start_time) AS start_time
    FROM roster_assignments a
    JOIN shift_codes s ON s.id = a.shift_code_id
    WHERE a.user_id = ?
      AND a.branch_id = ?
      AND a.assignment_date = ?
  `).get(userId, branchId, dateBkk) as { start_time: string | null } | undefined;
  return row?.start_time ?? null;
}

/** Bulk variant: returns Map<userId, "HH:MM"|null> for every user in
 *  the given list. Used by monthly aggregators (SVC, daily summary)
 *  so we don't hit the DB once per user per day. dateBkk is a single
 *  calendar date; the call is repeated per day in the loop. */
export function effectiveShiftStartByUserForDate(
  branchId: number,
  dateBkk: string,
  userIds: number[]
): Map<number, string> {
  const out = new Map<number, string>();
  if (userIds.length === 0) return out;
  const placeholders = userIds.map(() => "?").join(",");
  const rows = getDb().prepare(`
    SELECT a.user_id, MIN(s.start_time) AS start_time
    FROM roster_assignments a
    JOIN shift_codes s ON s.id = a.shift_code_id
    WHERE a.branch_id = ?
      AND a.assignment_date = ?
      AND a.user_id IN (${placeholders})
    GROUP BY a.user_id
  `).all(branchId, dateBkk, ...userIds) as Array<{ user_id: number; start_time: string }>;
  for (const r of rows) out.set(r.user_id, r.start_time);
  return out;
}

/** Per-month scheduled minutes per user — used as the denominator in
 *  the late-ratio + SVC eligibility calculation. Replaces the
 *  conservative "daysInMonth × 8h" assumption with the actual
 *  assigned-shift minutes. Caller can fall back to the legacy
 *  assumption when this returns 0 (no roster). */
export function scheduledMinutesByUserForMonth(
  branchId: number,
  yearMonth: string,
  userIds: number[]
): Map<number, number> {
  const out = new Map<number, number>();
  if (userIds.length === 0) return out;
  for (const id of userIds) out.set(id, 0);
  const placeholders = userIds.map(() => "?").join(",");
  const start = `${yearMonth}-01`;
  const end = `${yearMonth}-31`;
  // Sum (end - start) minutes per (user, day) ignoring breaks. We
  // subtract break minutes too so the denominator matches what the
  // staff was actually paid to be there.
  const rows = getDb().prepare(`
    SELECT a.user_id,
           s.start_time, s.end_time, s.break_start, s.break_end
    FROM roster_assignments a
    JOIN shift_codes s ON s.id = a.shift_code_id
    WHERE a.branch_id = ?
      AND a.assignment_date >= ? AND a.assignment_date <= ?
      AND a.user_id IN (${placeholders})
  `).all(branchId, start, end, ...userIds) as Array<{
    user_id: number;
    start_time: string; end_time: string;
    break_start: string | null; break_end: string | null;
  }>;
  for (const r of rows) {
    const shiftMin = hhmmDiff(r.start_time, r.end_time);
    const breakMin = (r.break_start && r.break_end) ? hhmmDiff(r.break_start, r.break_end) : 0;
    const net = Math.max(0, shiftMin - breakMin);
    out.set(r.user_id, (out.get(r.user_id) ?? 0) + net);
  }
  return out;
}

/** Count of staff assigned to each date in a leave range — used by
 *  the leave-approval-conflict warning. Returns a map keyed by
 *  YYYY-MM-DD. Empty days are omitted from the map. */
export function staffCountByDate(
  branchId: number,
  dateFromBkk: string,
  dateToBkk: string
): Map<string, number> {
  const out = new Map<string, number>();
  const rows = getDb().prepare(`
    SELECT assignment_date AS d, COUNT(DISTINCT user_id) AS n
    FROM roster_assignments
    WHERE branch_id = ?
      AND assignment_date >= ? AND assignment_date <= ?
    GROUP BY assignment_date
  `).all(branchId, dateFromBkk, dateToBkk) as Array<{ d: string; n: number }>;
  for (const r of rows) out.set(r.d, r.n);
  return out;
}

/** List the days in a date range where a specific user has at least
 *  one roster assignment. Returned as a sorted array of YYYY-MM-DD
 *  strings. Drives the warning shown above the leave-approval button
 *  ("ลาทับ 3 วันที่มอบหมายงานไว้"). */
export function userAssignmentDatesInRange(
  branchId: number,
  userId: number,
  dateFromBkk: string,
  dateToBkk: string
): string[] {
  const rows = getDb().prepare(`
    SELECT DISTINCT assignment_date FROM roster_assignments
    WHERE branch_id = ? AND user_id = ?
      AND assignment_date >= ? AND assignment_date <= ?
    ORDER BY assignment_date ASC
  `).all(branchId, userId, dateFromBkk, dateToBkk) as Array<{ assignment_date: string }>;
  return rows.map((r) => r.assignment_date);
}

/** Per-user-per-date roster shift_start map for an entire month.
 *  When a (user, date) pair has no roster row, the entry is omitted
 *  rather than holding the fallback static value — callers handle
 *  the "no roster row, use fallback" decision per their own rules
 *  (some skip the day entirely; payroll falls back to the static
 *  users.shift_start_time). */
export function shiftStartByDateForUserMonth(
  branchId: number,
  userId: number,
  yearMonth: string
): Map<string, string> {
  const start = `${yearMonth}-01`;
  const end = `${yearMonth}-31`;
  const out = new Map<string, string>();
  const rows = getDb().prepare(`
    SELECT a.assignment_date, MIN(s.start_time) AS start_time
    FROM roster_assignments a
    JOIN shift_codes s ON s.id = a.shift_code_id
    WHERE a.branch_id = ? AND a.user_id = ?
      AND a.assignment_date >= ? AND a.assignment_date <= ?
    GROUP BY a.assignment_date
  `).all(branchId, userId, start, end) as Array<{ assignment_date: string; start_time: string }>;
  for (const r of rows) out.set(r.assignment_date, r.start_time);
  return out;
}

/** Late stats for one user over the month, using the roster's
 *  per-day shift_start when available, falling back to a static
 *  shift_start (typically users.shift_start_time) only on days the
 *  user has no roster row but the legacy column is set.
 *
 *  Conservative day-off rule: if neither a roster row nor a fallback
 *  exists for a date AND the user clocked in anyway, we treat that
 *  clock-in as "not late" (no shift was assigned, so any presence is
 *  bonus — admin can still see it via the raw entry count).
 *
 *  scheduledMinutes is the denominator for the 20% SC threshold. It
 *  comes from scheduledMinutesByUserForMonth (real roster hours) or
 *  the conservative daysInMonth × 8h fallback. */
export function monthlyLateStatsRoster(
  entries: Array<{ ts: string }>,
  rosterShiftStartByDate: Map<string, string>,
  fallbackShiftStart: string | null,
  scheduledMinutes: number
): {
  lateCount: number;
  totalMinutesLate: number;
  ratio: number;
  scEligible: boolean;
  computable: boolean;
} {
  let lateCount = 0;
  let totalMinutesLate = 0;
  let anyComputable = false;
  for (const e of entries) {
    // Bangkok date of this clock-in
    const bkk = new Date(new Date(e.ts).getTime() + 7 * 60 * 60 * 1000);
    const dateBkk = bkk.toISOString().slice(0, 10);
    const start = rosterShiftStartByDate.get(dateBkk) ?? fallbackShiftStart;
    if (!start) continue;  // can't compute — skip
    anyComputable = true;
    const r = computeLateness(e.ts, start);
    if (r.isLate) {
      lateCount += 1;
      totalMinutesLate += r.minutesLate;
    }
  }
  const ratio = scheduledMinutes > 0 ? totalMinutesLate / scheduledMinutes : 0;
  return {
    lateCount,
    totalMinutesLate,
    ratio,
    scEligible: ratio <= SC_INELIGIBILITY_THRESHOLD,
    computable: anyComputable
  };
}

// ── Writes ───────────────────────────────────────────────────────

export function upsertAssignment(args: {
  branchId: number;
  date: string;       // YYYY-MM-DD
  positionId: number;
  userId: number;
  shiftCodeId: number;
  actingUserId: number;
}): { id: number; created: boolean } {
  const db = getDb();
  const nowIso = new Date().toISOString();
  const existing = db.prepare(`
    SELECT id FROM roster_assignments
    WHERE branch_id = ? AND assignment_date = ? AND position_id = ?
  `).get(args.branchId, args.date, args.positionId) as { id: number } | undefined;
  if (existing) {
    db.prepare(`
      UPDATE roster_assignments
      SET user_id = ?, shift_code_id = ?,
          updated_by = ?, updated_at = ?
      WHERE id = ?
    `).run(args.userId, args.shiftCodeId, args.actingUserId, nowIso, existing.id);
    return { id: existing.id, created: false };
  }
  const info = db.prepare(`
    INSERT INTO roster_assignments
      (branch_id, assignment_date, position_id, user_id, shift_code_id, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(args.branchId, args.date, args.positionId, args.userId, args.shiftCodeId, args.actingUserId, nowIso);
  return { id: Number(info.lastInsertRowid), created: true };
}

export function deleteAssignment(args: {
  branchId: number;
  date: string;
  positionId: number;
}): boolean {
  const r = getDb().prepare(`
    DELETE FROM roster_assignments
    WHERE branch_id = ? AND assignment_date = ? AND position_id = ?
  `).run(args.branchId, args.date, args.positionId);
  return r.changes > 0;
}

export function recordPublish(
  branchId: number, yearMonth: string,
  kind: "publish" | "edit", publishedBy: number, note?: string | null
): number {
  const r = getDb().prepare(`
    INSERT INTO roster_publish_log (branch_id, year_month, kind, note, published_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(branchId, yearMonth, kind, note ?? null, publishedBy);
  return Number(r.lastInsertRowid);
}

// ── Internals ────────────────────────────────────────────────────

/** Difference between two HH:MM strings in minutes. Handles overnight
 *  wraps (end < start) by adding 24h, so a 22:00→02:00 shift comes
 *  out as 240 minutes. */
function hhmmDiff(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60;
  return mins;
}
