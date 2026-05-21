// /lib/monthly-attendance-stats — the richer monthly summary that drives
// /admin/persona/timesheets/monthly. For each staff in the branch it
// computes:
//
//   • workedMinutes      — actual time-on-the-clock, capped at the
//                          rostered shift bounds, with the 5-minute
//                          grace window on both sides. Time outside
//                          the shift (early-in / late-out) is ignored
//                          since OT isn't auto-approved here.
//
//   • lateCount          — days the staff clocked in > 5 min after
//                          shift start.
//   • earlyOutCount      — days the staff clocked out > 5 min before
//                          shift end (without an approved OT, which
//                          this calc doesn't yet handle).
//
//   • lateMinutesTotal   — sum of minutes-late across the month.
//   • earlyOutMinutesTotal — sum of minutes-early-out.
//
//   • leaveCountByType   — { sick: 2, personal: 1, ... }; only approved
//                          leaves whose date_from falls in the month
//                          are counted.
//   • totalLeaveDays     — sum of approved leave days in the month.
//   • leavesOnRestrictedDays — approved leaves on days the business
//                          flagged "ขอความร่วมมือไม่ลา" (weekends +
//                          public holidays). Drives admin's attention.
//   • abnormalLeaveCount — approved leaves where created_at >= date_from
//                          (filed same-day or after) — a proxy for
//                          "ลากระทันหัน".
//
//   • combinedPenaltyPct — (lateCount + earlyOutCount +
//                          leavesOnRestrictedDays + abnormalLeaveCount)
//                          divided by scheduledDays × 100. Drives the
//                          SC eligibility tier.
//
//   • scTier             — 'full' (0-20% — no impact)
//                         | 'half' (21-50% — -50% SC)
//                         | 'none' (>50% — -100% SC)
//
// The denominator (scheduledDays / scheduledMinutes) comes from the
// roster when available, falling back to a conservative 8h × days-in-
// month when the branch hasn't filled in the roster. `computable: false`
// surfaces in the result when neither is available; the UI renders "—"
// in that case so admin doesn't see misleading zeros.

import { getDb } from "./db";
import { computeLateness, LATE_GRACE_MINUTES } from "./late-detection";

// Tier breakpoints — kept here so the UI and the engine stay in sync.
// 0-20%: full SC. 21-50%: 50%. >50%: 0%.
export const SC_TIER_HALF_THRESHOLD_PCT = 20;   // > 20 → half-tier
export const SC_TIER_NONE_THRESHOLD_PCT = 50;   // > 50 → none-tier

export type ScTier = "full" | "half" | "none";

export type MonthlyAttendanceStats = {
  user_id: number;
  computable: boolean;          // false when no roster + no fallback shift_start
  scheduledDays: number;
  scheduledMinutes: number;
  workedMinutes: number;
  // Late / early-out
  lateCount: number;
  earlyOutCount: number;
  lateMinutesTotal: number;
  earlyOutMinutesTotal: number;
  // Leave
  leaveCountByType: Record<string, number>;
  totalLeaveDays: number;
  leavesOnRestrictedDays: number;
  abnormalLeaveCount: number;
  // Combined
  combinedPenaltyPct: number;
  scTier: ScTier;
};

// ── Internal helpers ─────────────────────────────────────────────────

function hhmmToMin(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

function bkkDateOfIso(iso: string): string {
  const ms = new Date(iso).getTime() + 7 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function bkkMinOfIso(iso: string): number {
  const d = new Date(iso);
  const bkk = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return bkk.getUTCHours() * 60 + bkk.getUTCMinutes();
}

function isWeekend(dateBkk: string): boolean {
  const d = new Date(`${dateBkk}T00:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
}

function pickSctier(pct: number): ScTier {
  if (pct > SC_TIER_NONE_THRESHOLD_PCT) return "none";
  if (pct > SC_TIER_HALF_THRESHOLD_PCT) return "half";
  return "full";
}

function monthRange(yearMonth: string): { from: string; to: string; lastDay: number } {
  const [y, m] = yearMonth.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    from: `${yearMonth}-01`,
    to: `${yearMonth}-${String(lastDay).padStart(2, "0")}`,
    lastDay
  };
}

// ── Main entrypoint ──────────────────────────────────────────────────

/** Roster row per (user, date). When a user has multiple positions on
 *  the same date we union their bounds — earliest start, latest end,
 *  largest break span — so a long split shift is captured. */
type DayShift = {
  start_min: number;       // shift start in minutes-since-midnight
  end_min: number;         // shift end in minutes-since-midnight
  break_start_min: number | null;
  break_end_min: number | null;
};

function loadRosterDayShifts(
  branchId: number,
  yearMonth: string,
  userIds: number[]
): Map<number, Map<string, DayShift>> {
  const out = new Map<number, Map<string, DayShift>>();
  for (const id of userIds) out.set(id, new Map());
  if (userIds.length === 0) return out;
  const placeholders = userIds.map(() => "?").join(",");
  const { from, to } = monthRange(yearMonth);
  const rows = getDb().prepare(`
    SELECT a.user_id, a.assignment_date,
           s.start_time, s.end_time, s.break_start, s.break_end
    FROM roster_assignments a
    JOIN shift_codes s ON s.id = a.shift_code_id
    WHERE a.branch_id = ?
      AND a.assignment_date >= ? AND a.assignment_date <= ?
      AND a.user_id IN (${placeholders})
  `).all(branchId, from, to, ...userIds) as Array<{
    user_id: number; assignment_date: string;
    start_time: string; end_time: string;
    break_start: string | null; break_end: string | null;
  }>;
  for (const r of rows) {
    const start = hhmmToMin(r.start_time);
    const end = hhmmToMin(r.end_time);
    if (start == null || end == null) continue;
    const bs = hhmmToMin(r.break_start);
    const be = hhmmToMin(r.break_end);
    const dayMap = out.get(r.user_id)!;
    const existing = dayMap.get(r.assignment_date);
    if (existing) {
      // Multiple positions same day — union bounds.
      existing.start_min = Math.min(existing.start_min, start);
      existing.end_min = Math.max(existing.end_min, end);
      if (bs != null && be != null) {
        if (existing.break_start_min == null) {
          existing.break_start_min = bs;
          existing.break_end_min = be;
        } else {
          existing.break_start_min = Math.min(existing.break_start_min, bs);
          existing.break_end_min = Math.max(existing.break_end_min!, be);
        }
      }
    } else {
      dayMap.set(r.assignment_date, {
        start_min: start,
        end_min: end,
        break_start_min: bs,
        break_end_min: be
      });
    }
  }
  return out;
}

/** Synthesize a DayShift from the legacy users.shift_start_time when no
 *  roster row exists. Assumes 8h shift, no break. Returns null when
 *  there's no fallback either. */
function synthDayShiftFromFallback(fallbackStart: string | null): DayShift | null {
  const start = hhmmToMin(fallbackStart);
  if (start == null) return null;
  return {
    start_min: start,
    end_min: Math.min(start + 8 * 60, 24 * 60),
    break_start_min: null,
    break_end_min: null
  };
}

/** Pair an array of clock events (sorted ascending by ts) into in/out
 *  pairs. A leading "out" with no preceding "in" is discarded; a
 *  trailing "in" with no closing "out" is also discarded (counts as
 *  unpaired). */
function pairInOut(events: Array<{ ts: string; type: "in" | "out" }>):
  Array<{ inTs: string; outTs: string }>
{
  const pairs: Array<{ inTs: string; outTs: string }> = [];
  let openIn: string | null = null;
  for (const e of events) {
    if (e.type === "in") {
      openIn = e.ts;
    } else if (openIn != null) {
      pairs.push({ inTs: openIn, outTs: e.ts });
      openIn = null;
    }
  }
  return pairs;
}

export function computeMonthlyAttendanceStats(
  branchId: number,
  yearMonth: string,
  users: Array<{ user_id: number; shift_start_time: string | null }>
): Map<number, MonthlyAttendanceStats> {
  const out = new Map<number, MonthlyAttendanceStats>();
  const userIds = users.map((u) => u.user_id);
  const fallbackByUser = new Map<number, string | null>();
  for (const u of users) fallbackByUser.set(u.user_id, u.shift_start_time);

  const { from, to, lastDay } = monthRange(yearMonth);
  const fromIso = new Date(`${from}T00:00:00+07:00`).toISOString();
  const toIso = new Date(`${to}T23:59:59+07:00`).toISOString();

  // Roster days
  const rosterByUser = loadRosterDayShifts(branchId, yearMonth, userIds);

  // Public holidays in the month — treated as restricted days.
  const holidays = getDb().prepare(`
    SELECT date FROM public_holidays
    WHERE date >= ? AND date <= ? AND is_workday = 0
  `).all(from, to) as Array<{ date: string }>;
  const holidaySet = new Set(holidays.map((h) => h.date));

  // Clock entries per user
  const entries = getDb().prepare(`
    SELECT user_id, type, ts FROM time_entries
    WHERE branch_id = ? AND ts >= ? AND ts <= ?
    ORDER BY user_id, ts
  `).all(branchId, fromIso, toIso) as Array<{
    user_id: number; type: "in" | "out"; ts: string;
  }>;
  const entriesByUser = new Map<number, Array<{ type: "in" | "out"; ts: string }>>();
  for (const e of entries) {
    if (!entriesByUser.has(e.user_id)) entriesByUser.set(e.user_id, []);
    entriesByUser.get(e.user_id)!.push({ type: e.type, ts: e.ts });
  }

  // Approved leaves with date_from in the month. We then expand each
  // request's date range to count days, capped to the month bounds.
  const placeholders = userIds.length > 0 ? userIds.map(() => "?").join(",") : "NULL";
  const leaveRows = userIds.length === 0 ? [] : (getDb().prepare(`
    SELECT user_id, type, date_from, date_to, days, created_at
    FROM leave_requests
    WHERE branch_id = ? AND status = 'approved'
      AND NOT (date_to < ? OR date_from > ?)
      AND user_id IN (${placeholders})
  `).all(branchId, from, to, ...userIds) as Array<{
    user_id: number; type: string; date_from: string; date_to: string;
    days: number; created_at: string;
  }>);

  for (const u of users) {
    const stats: MonthlyAttendanceStats = {
      user_id: u.user_id,
      computable: false,
      scheduledDays: 0,
      scheduledMinutes: 0,
      workedMinutes: 0,
      lateCount: 0,
      earlyOutCount: 0,
      lateMinutesTotal: 0,
      earlyOutMinutesTotal: 0,
      leaveCountByType: {},
      totalLeaveDays: 0,
      leavesOnRestrictedDays: 0,
      abnormalLeaveCount: 0,
      combinedPenaltyPct: 0,
      scTier: "full"
    };

    const dayMap = rosterByUser.get(u.user_id) ?? new Map<string, DayShift>();
    const fallback = synthDayShiftFromFallback(fallbackByUser.get(u.user_id) ?? null);

    // Pre-compute the set of dates the user has a known shift (roster
    // or fallback). For roster: every day with a row counts. For
    // fallback: skip — the legacy column has no "which days do I
    // actually work?" info, so we can't safely count scheduledDays
    // from it. This means users without a roster get computable=false
    // for the worked-minutes / late-count metrics (we surface "—" in
    // the UI) — matching the existing monthlyLateStatsRoster behaviour.
    const rosterDates = Array.from(dayMap.keys());
    if (rosterDates.length === 0 && !fallback) {
      out.set(u.user_id, stats);
      continue;
    }

    stats.computable = true;
    stats.scheduledDays = rosterDates.length;

    // ── workedMinutes + late/early ───────────────────────────────────
    const userEntries = entriesByUser.get(u.user_id) ?? [];
    const pairs = pairInOut(userEntries);

    // Group pairs by the in's Bangkok date — overnight shifts that cross
    // midnight are uncommon enough to ignore (treated as the open day).
    const pairsByDate = new Map<string, Array<{ inTs: string; outTs: string }>>();
    for (const p of pairs) {
      const d = bkkDateOfIso(p.inTs);
      if (!pairsByDate.has(d)) pairsByDate.set(d, []);
      pairsByDate.get(d)!.push(p);
    }

    // Scheduled minutes sum across all roster days (net of breaks). For
    // pure-fallback users this stays 0; we leave it at the conservative
    // 0 instead of fudging an estimate.
    for (const ds of dayMap.values()) {
      const shiftMin = ds.end_min - ds.start_min;
      const breakMin = (ds.break_start_min != null && ds.break_end_min != null)
        ? Math.max(0, ds.break_end_min - ds.break_start_min) : 0;
      stats.scheduledMinutes += Math.max(0, shiftMin - breakMin);
    }

    // Iterate roster days — compute worked-minutes + late/early per day.
    for (const [date, ds] of dayMap) {
      const dayPairs = pairsByDate.get(date) ?? [];
      if (dayPairs.length === 0) continue;  // either leave or absence

      // For lateness: take the first "in" of the day vs shift start.
      const firstIn = dayPairs[0].inTs;
      const lateness = computeLateness(firstIn, minToHHMM(ds.start_min));
      if (lateness.isLate) {
        stats.lateCount += 1;
        stats.lateMinutesTotal += lateness.minutesLate;
      }

      // For early-out: take the last "out" of the day vs shift end.
      const lastOut = dayPairs[dayPairs.length - 1].outTs;
      const outMin = bkkMinOfIso(lastOut);
      const earlyByMin = ds.end_min - outMin;
      if (earlyByMin > LATE_GRACE_MINUTES) {
        stats.earlyOutCount += 1;
        stats.earlyOutMinutesTotal += earlyByMin;
      }

      // Worked minutes: sum each pair clamped to shift bounds, then
      // subtract any overlap with the break window. Times outside the
      // shift bounds count as 0 (no implicit OT credit).
      let dayWorked = 0;
      for (const p of dayPairs) {
        const inMin = bkkMinOfIso(p.inTs);
        const oMin = bkkMinOfIso(p.outTs);
        const clampedIn = Math.max(inMin, ds.start_min);
        const clampedOut = Math.min(oMin, ds.end_min);
        if (clampedOut <= clampedIn) continue;
        let span = clampedOut - clampedIn;
        if (ds.break_start_min != null && ds.break_end_min != null) {
          const overlapStart = Math.max(clampedIn, ds.break_start_min);
          const overlapEnd = Math.min(clampedOut, ds.break_end_min);
          if (overlapEnd > overlapStart) span -= (overlapEnd - overlapStart);
        }
        // 5-min grace: if late ≤ 5 min, give credit from shift start
        // (i.e. don't subtract those minutes). Same on the back end:
        // out ≤ 5 min early → credit through shift end.
        if (inMin <= ds.start_min + LATE_GRACE_MINUTES && inMin > ds.start_min) {
          span += (inMin - ds.start_min);
        }
        if (oMin >= ds.end_min - LATE_GRACE_MINUTES && oMin < ds.end_min) {
          span += (ds.end_min - oMin);
        }
        dayWorked += Math.max(0, span);
      }
      stats.workedMinutes += dayWorked;
    }

    // ── Leave counts ────────────────────────────────────────────────
    for (const lv of leaveRows) {
      if (lv.user_id !== u.user_id) continue;
      stats.leaveCountByType[lv.type] = (stats.leaveCountByType[lv.type] ?? 0) + 1;
      // Days span this month
      const start = lv.date_from < from ? from : lv.date_from;
      const end = lv.date_to > to ? to : lv.date_to;
      let cur = start;
      let daysInMonth = 0;
      while (cur <= end) {
        daysInMonth += 1;
        if (isWeekend(cur) || holidaySet.has(cur)) {
          stats.leavesOnRestrictedDays += 1;
        }
        const nd = new Date(`${cur}T00:00:00Z`);
        nd.setUTCDate(nd.getUTCDate() + 1);
        cur = nd.toISOString().slice(0, 10);
      }
      stats.totalLeaveDays += Math.min(lv.days, daysInMonth);

      // Abnormal — filed same day or after the leave started. created_at
      // is an ISO string; compare to date_from at end-of-day UTC so
      // submissions on the same calendar day count as "abnormal".
      const createdDate = lv.created_at.slice(0, 10);
      if (createdDate >= lv.date_from) {
        stats.abnormalLeaveCount += 1;
      }
    }

    // ── Combined penalty + SC tier ──────────────────────────────────
    if (stats.scheduledDays > 0) {
      const incidents = stats.lateCount + stats.earlyOutCount
        + stats.leavesOnRestrictedDays + stats.abnormalLeaveCount;
      stats.combinedPenaltyPct = (incidents / stats.scheduledDays) * 100;
      stats.scTier = pickSctier(stats.combinedPenaltyPct);
    } else if (fallback) {
      // No roster days; we can still detect late/early using fallback
      // start. Denominator becomes lastDay (rough working days proxy)
      // so the % is still meaningful.
      const incidents = stats.lateCount + stats.earlyOutCount
        + stats.leavesOnRestrictedDays + stats.abnormalLeaveCount;
      stats.combinedPenaltyPct = (incidents / lastDay) * 100;
      stats.scTier = pickSctier(stats.combinedPenaltyPct);
    }

    out.set(u.user_id, stats);
  }

  return out;
}

function minToHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const mm = min % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
