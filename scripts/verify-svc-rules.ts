// Fixture: the July+ SVC rules (owner 2026-07-21) — 480/day cap (OT excepted) and
// no-schedule-day exclusion — plus the finalize-completeness arithmetic. Uses the
// REAL payroll helpers for the minute math; the cap/exclusion/gate logic mirrors
// computeMonthlySvcSummary. Run:  node --import tsx scripts/verify-svc-rules.ts
import { pairShifts, applyPtGrace, pickScheduled, deductBreak } from "../src/lib/payroll-compute";
import { SVC_MAX_NORMAL_MINUTES } from "../src/lib/service-charge";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

const brk = {
  break_threshold_minutes: 300, break_deduction_minutes: 30,
  long_shift_threshold_minutes: 480, long_shift_break_minutes: 60
} as never;

// ── constant + gates ────────────────────────────────────────────
assert(SVC_MAX_NORMAL_MINUTES === 480, "normal cap = 480 min (8h)");
const capGate = (ym: string) => ym >= "2026-07";
const noSchedGate = (ym: string) => ym >= "2026-07";
assert(!capGate("2026-06") && capGate("2026-07"), "cap/no-sched gate = July+");
assert(!noSchedGate("2026-06"), "June is NOT subject to cap / no-schedule");

// ── minute math for a 9h shift (FD-12 12:00–21:00, 30-min break) ─
// Scheduled 12:00–21:00 with a 13:30–14:00 break → applyPtGrace deducts 30.
const date = "2026-07-14";
const sched = {
  startTs: new Date(`${date}T12:00:00+07:00`).toISOString(),
  endTs: new Date(`${date}T21:00:00+07:00`).toISOString(),
  breakStartTs: new Date(`${date}T13:30:00+07:00`).toISOString(),
  breakEndTs: new Date(`${date}T14:00:00+07:00`).toISOString()
};
// Clock in 11:57 (early → clamped to 12:00), out 21:33 (no OT → clamped to 21:00).
const list = [
  { user_id: 1, ts: new Date(`${date}T11:57:00+07:00`).toISOString(), type: "in" as const },
  { user_id: 1, ts: new Date(`${date}T21:33:00+07:00`).toISOString(), type: "out" as const }
];
const { shifts, unpaired } = pairShifts(list);
assert(unpaired === 0 && shifts.length === 1, "complete punch pairs into 1 shift");
const picked = pickScheduled([sched], shifts[0]);
const g = applyPtGrace({ startTs: shifts[0].startTs, endTs: shifts[0].endTs }, picked, null);
const worked = g.breakMinutes > 0 ? g.workedMinutes : deductBreak(g.workedMinutes, brk).workedMinutes;
assert(worked === 510, `9h shift − 30 break, out clamped to 21:00 = 510 (got ${worked})`);

// ── cap pass (mirrors computeMonthlySvcSummary 4c) ──────────────
const applyCap = (mins: number, hasOt: boolean) =>
  (mins > SVC_MAX_NORMAL_MINUTES && !hasOt) ? SVC_MAX_NORMAL_MINUTES : mins;
assert(applyCap(510, false) === 480, "510 normal day → capped to 480");
assert(applyCap(510, true) === 510, "510 with approved OT → NOT capped");
assert(applyCap(450, false) === 450, "under-cap day unchanged (450)");
assert(applyCap(480, false) === 480, "exactly 480 unchanged");

// ── no-schedule exclusion (mirrors computeSvcClampedMinutesByDay) ─
const isExcludedNoSched = (shiftCount: number, candidateCount: number, on: boolean) =>
  on && shiftCount > 0 && candidateCount === 0;
assert(isExcludedNoSched(1, 0, true), "clocked with 0 roster candidates (July) → excluded");
assert(!isExcludedNoSched(1, 1, true), "clocked WITH a roster shift → not excluded");
assert(!isExcludedNoSched(1, 0, false), "June (gate off) → not excluded even with no roster");

// ── finalize-completeness arithmetic ────────────────────────────
const daysInMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
assert(daysInMonth("2026-06") === 30, "June has 30 days");
assert(daysInMonth("2026-07") === 31, "July has 31 days");
const canFinalize = (filled: number, ym: string) => filled >= daysInMonth(ym);
assert(!canFinalize(29, "2026-06"), "29/30 days filled → finalize blocked");
assert(canFinalize(30, "2026-06"), "30/30 days filled → finalize allowed");

console.log("\nALL SVC-RULES FIXTURES PASSED");
