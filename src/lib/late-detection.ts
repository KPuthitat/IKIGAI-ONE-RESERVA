// Late-detection helpers used by the monthly timesheet view + the
// service-charge eligibility heuristic. Self-contained so the same
// logic powers admin reports, payroll exports, and (eventually) the
// staff-side "you were N minutes late today" message.
//
// Rules (per user spec, 2026-05-13):
//   • Grace window: 5 minutes after shift_start_time = not late.
//   • Over 5 min late → counts as 1 late event + N minutes late.
//   • Part-time staff: ≤5 min late → full-time credit; >5 min late
//     → deduct the actual minutes-late from their paid time.
//   • Monthly: if late_minutes_total > 20% of scheduled minutes,
//     staff is INELIGIBLE for the service-charge payout that month.

export const LATE_GRACE_MINUTES = 5;
export const SC_INELIGIBILITY_THRESHOLD = 0.20; // 20%

// Parse "HH:MM" → total minutes since midnight. Returns null on
// malformed input so callers can short-circuit.
function hhmmToMinutes(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

// Bangkok HH:MM minutes-since-midnight from an ISO timestamp.
export function bkkMinutes(iso: string): number {
  const d = new Date(iso);
  const bkk = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return bkk.getUTCHours() * 60 + bkk.getUTCMinutes();
}

/**
 * Compute lateness for a single clock-in event.
 *   - inIso:      ISO of the clock-in
 *   - shiftStart: "HH:MM" string for the user's expected start
 * Returns:
 *   - minutesLate: clock-in − shift_start; negative if early
 *   - isLate:      true once minutesLate > LATE_GRACE_MINUTES
 *   - computable:  false when shiftStart isn't set
 */
export function computeLateness(
  inIso: string,
  shiftStart: string | null | undefined
): { minutesLate: number; isLate: boolean; computable: boolean } {
  const start = hhmmToMinutes(shiftStart);
  if (start == null) {
    return { minutesLate: 0, isLate: false, computable: false };
  }
  const actual = bkkMinutes(inIso);
  const minutesLate = actual - start;
  return {
    minutesLate,
    isLate: minutesLate > LATE_GRACE_MINUTES,
    computable: true
  };
}

/**
 * Compute the part-time minute deduction for a single shift.
 * Spec: ≤5 min late → no deduction; >5 min late → deduct the
 * full lateness (so 8 min late = -8 min paid time).
 *
 * Returns 0 for full-time staff (their deduction is handled by the
 * monthly SC-eligibility rule instead).
 */
export function partTimeMinuteDeduction(
  minutesLate: number,
  employmentType: string | null
): number {
  if (employmentType !== "pt") return 0;
  if (minutesLate <= LATE_GRACE_MINUTES) return 0;
  return minutesLate;
}

/**
 * Roll up monthly late statistics across many clock-ins. Caller
 * pre-filters to a single user-month before passing in.
 *   - entries:    array of { ts, type } for the month (already
 *                 filtered to "in" events; "out" rows are ignored
 *                 for lateness purposes).
 *   - shiftStart: "HH:MM" expected start time
 *   - scheduledMinutes: total minutes the user was scheduled to
 *                 work in this month (caller computes from shift
 *                 days × shift duration). Used as the denominator
 *                 for the 20% SC threshold.
 *
 * Returns:
 *   - lateCount, totalMinutesLate, scEligible (true unless ratio
 *     exceeds threshold), ratio (for display).
 */
export function monthlyLateStats(
  entries: Array<{ ts: string }>,
  shiftStart: string | null,
  scheduledMinutes: number
): {
  lateCount: number;
  totalMinutesLate: number;
  ratio: number;
  scEligible: boolean;
} {
  let lateCount = 0;
  let totalMinutesLate = 0;
  for (const e of entries) {
    const r = computeLateness(e.ts, shiftStart);
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
    scEligible: ratio <= SC_INELIGIBILITY_THRESHOLD
  };
}
