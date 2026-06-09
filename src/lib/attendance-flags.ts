// Attendance anomaly detection + history (owner 2026-06-08).
//
// When a staff forgets to clock in/out, น้องฮูก records a gentle HISTORY
// flag (attendance_flags) and nudges them to certify the missing punch.
// This is intentionally NOT the disciplinary_warnings system — the owner
// chose a soft "we noticed, please fix it" record, not a formal warning.
//
// The detection runs AFTER a successful punch insert and is wrapped by the
// caller in try/catch; we also keep the body defensive so a bad row can
// never break the critical clock endpoint.

import { getDb } from "./db";
import { effectiveShiftStartForUserDate } from "./roster";
import { nameWithPrefix } from "./name";

export type OwlPromptKind = "missing_in" | "missing_out";
export type OwlPrompt = { kind: OwlPromptKind; work_date: string };

export type AttendanceFlagRow = {
  id: number;
  work_date: string;
  kind: string;
  detail: string | null;
  resolved_at: string | null;
  created_at: string;
};

function bkkDate(ts: string): string {
  return new Date(new Date(ts).getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

function dayRangeIso(dateBkk: string): [string, string] {
  return [
    new Date(`${dateBkk}T00:00:00+07:00`).toISOString(),
    new Date(`${dateBkk}T23:59:59+07:00`).toISOString()
  ];
}

/**
 * Detect a forgot-to-punch lapse right after a successful NEW punch and
 * record it in attendance_flags. Returns an owl prompt to surface to the
 * staff, or null when there's nothing to flag.
 *
 *   action 'in'  → if the most-recent prior working day had an 'in' but no
 *                  'out' (and wasn't an overnight shift), flag missing_out.
 *   action 'out' → if today still has no 'in', flag missing_in (defensive;
 *                  under the single-button auto-decide this is rare).
 *
 * INSERT OR IGNORE on the UNIQUE(user_id, work_date, kind) means a staff is
 * only prompted on FIRST detection of a given lapse — never nagged twice.
 */
export function detectPunchAnomaly(args: {
  userId: number;
  branchId: number;
  action: "in" | "out";
  todayBkk: string;
}): OwlPrompt | null {
  const db = getDb();
  const { userId, branchId, action, todayBkk } = args;
  const nowIso = new Date().toISOString();

  const flag = (kind: OwlPromptKind, workDate: string, detail: string): OwlPrompt | null => {
    const r = db.prepare(`
      INSERT OR IGNORE INTO attendance_flags
        (user_id, branch_id, work_date, kind, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, branchId, workDate, kind, detail, nowIso);
    return r.changes > 0 ? { kind, work_date: workDate } : null;
  };

  if (action === "in") {
    const [todayStart] = dayRangeIso(todayBkk);
    // Most-recent punch strictly before today → its calendar day.
    const prev = db.prepare(`
      SELECT ts FROM time_entries
      WHERE user_id = ? AND branch_id = ? AND ts < ?
      ORDER BY ts DESC LIMIT 1
    `).get(userId, branchId, todayStart) as { ts: string } | undefined;
    if (!prev) return null;
    const prevDate = bkkDate(prev.ts);
    const [s, e] = dayRangeIso(prevDate);
    const rows = db.prepare(`
      SELECT type, COUNT(*) AS n FROM time_entries
      WHERE user_id = ? AND branch_id = ? AND ts >= ? AND ts <= ?
      GROUP BY type
    `).all(userId, branchId, s, e) as Array<{ type: "in" | "out"; n: number }>;
    const hasIn = rows.some((r) => r.type === "in" && r.n > 0);
    const hasOut = rows.some((r) => r.type === "out" && r.n > 0);
    if (hasIn && !hasOut) {
      // Overnight shifts legitimately punch out the next calendar day —
      // don't flag those as a missing clock-out.
      const overnight = db.prepare(`
        SELECT 1 FROM roster_assignments a
        JOIN shift_codes s ON s.id = a.shift_code_id
        WHERE a.user_id = ? AND a.assignment_date = ? AND s.end_time < s.start_time
        LIMIT 1
      `).get(userId, prevDate);
      if (overnight) return null;
      return flag("missing_out", prevDate, "ลงเวลาเข้าแต่ไม่มีเวลาออก");
    }
    return null;
  }

  // action === "out"
  const [s, e] = dayRangeIso(todayBkk);
  const hasIn = db.prepare(`
    SELECT 1 FROM time_entries
    WHERE user_id = ? AND branch_id = ? AND type = 'in' AND ts >= ? AND ts <= ? LIMIT 1
  `).get(userId, branchId, s, e);
  if (!hasIn) return flag("missing_in", todayBkk, "ลงเวลาออกแต่ไม่มีเวลาเข้า");
  return null;
}

// ── Schedule-deviation detection (owner 2026-06-08) ──────────────────
// At clock-in, compare the actual punch to the rostered start. If it's
// far off (≥ threshold), น้องฮูก asks whether the staff is simply
// late/early or covering a friend's shift (a swap). Only fires when a
// roster shift exists for the day — no schedule, no comparison.

export type SwapCandidate = {
  user_id: number;
  name: string;      // display name with prefix
  sched_in: string;  // HH:MM
  sched_out: string; // HH:MM
};

export type DeviationPrompt = {
  kind: "late_or_swap" | "early_or_swap";
  sched_start: string; // HH:MM rostered start
  actual: string;      // HH:MM actual clock-in
  work_date: string;   // YYYY-MM-DD (BKK)
  candidates: SwapCandidate[];
};

// Off-by-this-much (minutes) before we bother asking. Below it, a minor
// late is left to the normal payroll late calc; we only interrupt for a
// gap big enough to plausibly be a swap.
const DEVIATION_THRESHOLD_MIN = 30;

function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function detectScheduleDeviation(args: {
  userId: number;
  branchId: number;
  todayBkk: string;
  actualIso: string;
}): DeviationPrompt | null {
  const db = getDb();
  const { userId, branchId, todayBkk, actualIso } = args;

  const schedStart = effectiveShiftStartForUserDate(userId, branchId, todayBkk);
  if (!schedStart) return null; // no roster today → nothing to compare

  const actual = new Date(new Date(actualIso).getTime() + 7 * 3600_000)
    .toISOString().slice(11, 16);
  const dev = hhmmToMin(actual) - hhmmToMin(schedStart); // + late, − early
  if (Math.abs(dev) < DEVIATION_THRESHOLD_MIN) return null;

  // Other staff rostered today at this branch — the shifts a swap could
  // cover. Earliest-start shift per person (a person may hold multiple
  // positions in a day).
  const rows = db.prepare(`
    SELECT a.user_id, u.display_name AS name, u.title_prefix AS prefix,
           s.start_time AS sched_in, s.end_time AS sched_out
    FROM roster_assignments a
    JOIN shift_codes s ON s.id = a.shift_code_id
    JOIN users u ON u.id = a.user_id
    WHERE a.branch_id = ? AND a.assignment_date = ? AND a.user_id != ?
      AND s.kind = 'work'
    ORDER BY a.user_id, s.start_time
  `).all(branchId, todayBkk, userId) as Array<{
    user_id: number; name: string; prefix: string | null;
    sched_in: string; sched_out: string;
  }>;
  const byUser = new Map<number, typeof rows[number]>();
  for (const r of rows) if (!byUser.has(r.user_id)) byUser.set(r.user_id, r);
  const candidates: SwapCandidate[] = [...byUser.values()].map((r) => ({
    user_id: r.user_id,
    name: nameWithPrefix(r.prefix, r.name),
    sched_in: r.sched_in,
    sched_out: r.sched_out
  }));

  return {
    kind: dev > 0 ? "late_or_swap" : "early_or_swap",
    sched_start: schedStart,
    actual,
    work_date: todayBkk,
    candidates
  };
}

/** Recent flags for a user, newest first — for the staff history list. */
export function listAttendanceFlagsForUser(userId: number, limit = 20): AttendanceFlagRow[] {
  return getDb().prepare(`
    SELECT id, work_date, kind, detail, resolved_at, created_at
    FROM attendance_flags WHERE user_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(userId, limit) as AttendanceFlagRow[];
}
