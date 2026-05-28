// Deploy safety guard. Tells deploy.sh (and Claude before suggesting
// a deploy) whether the current moment is too close to a shift
// start / end time across all branches. Owner direction 2026-05-28:
//
//   • Block the 15-minute window BEFORE and AFTER each shift's
//     start_time and end_time, for every branch in the system.
//   • Read times from shift_codes via roster_assignments for TODAY
//     (Bangkok) — so a branch with no roster today doesn't block.
//   • When the script hits a blocked window, prompt the operator
//     (or Claude) for an explicit y/n decision.
//
// Why per-branch + per-day: each branch has its own schedule; some
// open at 10:00, others at 16:00. Blocking on the union of every
// possible time on the calendar would mean almost no safe window
// at all. Reading today's assignments narrows to actual entry/exit
// moments staff are about to perform.

import { getDb } from "./db";
import { todayBkk } from "./time";

/** Half-width of the no-deploy window around each shift edge, in
 *  minutes. Owner direction 2026-05-28: 15 min before + 15 min after
 *  = a 30-min no-deploy zone centred on each entry/exit. */
export const WINDOW_MINUTES = 15;

export type DeployWindowResult = {
  /** True = nothing dangerous in the next/last WINDOW_MINUTES;
   *  deploy can proceed without prompting. */
  safe: boolean;
  /** Human-readable lines describing what's near. Empty when safe.
   *  Each line names the branch + shift code + edge (start/end) +
   *  signed minutes (positive = upcoming, negative = just happened).
   *  deploy.sh prints these verbatim above the y/n prompt. */
  warnings: string[];
  /** Earliest ISO time when the next safe window starts (i.e. when
   *  the closest blocking edge falls outside the ±WINDOW_MINUTES
   *  zone). Useful for "try again at HH:MM". null when already safe. */
  nextSafeAt: string | null;
};

/** Parse "HH:MM" into minutes since midnight. Tolerates "H:MM" too. */
function hhmmToMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** Current Bangkok wall-clock time in minutes-since-midnight. */
function nowBkkMinutes(now: Date): number {
  const bkk = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return bkk.getUTCHours() * 60 + bkk.getUTCMinutes();
}

/** Main entry point. Reads today's roster across all branches,
 *  unions the shift start/end times, returns whether we're inside
 *  the no-deploy window for any of them. */
export function checkDeployWindow(now: Date = new Date()): DeployWindowResult {
  const today = todayBkk();
  const nowMin = nowBkkMinutes(now);

  // One query — every distinct (branch, shift_code) pair scheduled
  // on a position today. Edges may repeat across positions on the
  // same shift; we de-dupe via the SQL distinct.
  const rows = getDb().prepare(`
    SELECT DISTINCT
      b.name        AS branch_name,
      sc.code       AS shift_code,
      sc.name       AS shift_name,
      sc.start_time AS start_time,
      sc.end_time   AS end_time
    FROM roster_assignments ra
    JOIN shift_codes sc ON sc.id = ra.shift_code_id
    JOIN branches    b  ON b.id  = ra.branch_id
    WHERE ra.assignment_date = ?
  `).all(today) as Array<{
    branch_name: string;
    shift_code: string;
    shift_name: string | null;
    start_time: string;
    end_time: string;
  }>;

  if (rows.length === 0) {
    return { safe: true, warnings: [], nextSafeAt: null };
  }

  // Build the list of "edges" — each shift contributes two edges
  // (entry + exit) per branch. Skip entries with unparseable times
  // (corrupt seed data) rather than crashing the check.
  type Edge = {
    branchName: string;
    shiftCode: string;
    edge: "เข้างาน" | "ออกงาน";
    timeMin: number;
    timeLabel: string;
  };
  const edges: Edge[] = [];
  for (const r of rows) {
    const startMin = hhmmToMinutes(r.start_time);
    const endMin = hhmmToMinutes(r.end_time);
    if (startMin !== null) {
      edges.push({
        branchName: r.branch_name,
        shiftCode: r.shift_code,
        edge: "เข้างาน",
        timeMin: startMin,
        timeLabel: r.start_time
      });
    }
    if (endMin !== null) {
      edges.push({
        branchName: r.branch_name,
        shiftCode: r.shift_code,
        edge: "ออกงาน",
        timeMin: endMin,
        timeLabel: r.end_time
      });
    }
  }

  // Inside-window check. We want |edge - now| <= WINDOW_MINUTES for
  // ANY edge to mark this moment unsafe.
  const insideWindow = edges.filter((e) => Math.abs(e.timeMin - nowMin) <= WINDOW_MINUTES);

  if (insideWindow.length > 0) {
    // Sort by absolute distance so the closest is first in the
    // warning output — operator sees "DEPLOY BLOCKED · NAMA เข้างาน
    // 16:00 (อีก 3 นาที)" most prominently.
    insideWindow.sort((a, b) => Math.abs(a.timeMin - nowMin) - Math.abs(b.timeMin - nowMin));
    const warnings = insideWindow.map((e) => {
      const delta = e.timeMin - nowMin;
      const human = delta === 0
        ? "ตอนนี้!"
        : delta > 0
          ? `อีก ${delta} นาที`
          : `ผ่านมา ${Math.abs(delta)} นาที`;
      return `${e.branchName} · ${e.shiftCode} ${e.edge} ${e.timeLabel} (${human})`;
    });
    // Next safe time = current furthest edge endpoint + 1 minute,
    // assuming no other edges fall within the same 30-min window
    // after that. For simplicity we just return the time when the
    // CURRENT closest edge fully passes (now + closest_distance_to_window_exit).
    const closest = insideWindow[0];
    const exitsAt = closest.timeMin + WINDOW_MINUTES + 1;
    const nextSafeAt = buildIsoBkkAtMinutes(today, exitsAt);
    return { safe: false, warnings, nextSafeAt };
  }

  return { safe: true, warnings: [], nextSafeAt: null };
}

/** Construct an ISO timestamp at the given YYYY-MM-DD + minutes-
 *  since-midnight in Bangkok. Used for nextSafeAt so the operator
 *  can see "พร้อม deploy ได้อีกครั้งตอน 16:16". */
function buildIsoBkkAtMinutes(dateBkk: string, totalMin: number): string {
  const [y, m, d] = dateBkk.split("-").map(Number);
  // Bangkok = UTC+7, no DST. Construct the wall-clock time as UTC
  // then subtract 7h to get the actual UTC instant.
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  const ms = Date.UTC(y, m - 1, d, hh, mm) - 7 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}
