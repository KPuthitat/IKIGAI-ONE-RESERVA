// Payroll computation engine — pure functions + DB writer
//
// Inputs (from DB):
//  - payroll_settings (singleton): OT mode, break rules, SSO, PT default rate
//  - users + their payroll fields (hourly_rate, monthly_salary, pay_cycle)
//  - time_entries within the period
//  - leave_requests (status=approved) overlapping the period
//
// Outputs:
//  - payroll_lines (one per employee per period)
//
// Rules:
//  PT: pay = (regular_minutes / 60) × hourly_rate
//      OT  = computed by mode (flat or legal)
//  FT-monthly: pay = monthly_salary (regardless of period — but only included
//                    in monthly cycles, never weekly)
//  FT-weekly:  pay = monthly_salary / number_of_pay_periods_in_month
//  Break: auto-deduct based on shift length thresholds
//  OT:    everything beyond 480 min (8 hr) per shift after break deduction
//  SSO:   min(base_salary × rate, cap_for_period)  — base only, excl OT/other;
//         cap pro-rated for weekly (owner 2026-07-04)
//  Tax:   Thai PIT progressive — annualized
//
// All amounts in THB. Time in minutes. Dates in Bangkok local.

import type Database from "better-sqlite3";
import { sumRedeemedDrinksForUser } from "./partner-drink-orders";
import { sumCrossCompanyChargesForUser } from "./mealpass-payroll";
import { isDfBranch, computeDoctorFees } from "./df-db";

// ── Types ───────────────────────────────────────────────────────────

export type PayrollSettings = {
  ot_mode: "flat" | "legal";
  ot_flat_per_15min: number;
  break_threshold_minutes: number;
  break_deduction_minutes: number;
  long_shift_threshold_minutes: number;
  long_shift_break_minutes: number;
  sso_rate: number;
  sso_cap: number;
  pt_default_hourly_rate: number;
  wht_rate: number;
};

export type EmployeePayrollSnapshot = {
  user_id: number;
  display_name: string;
  employment_type: "pt" | "ft" | null;
  employee_code: string | null;
  hourly_rate: number | null;
  monthly_salary: number | null;
  pay_cycle: "weekly" | "monthly" | null;
  salary_tax_mode: "sso" | "wht" | null;
  /** 0 = salaried exec/admin who doesn't clock in → flat salary, no OT, no SVC
   *  (owner 2026-07-12). 1 = normal, attendance-tracked. */
  track_attendance: number;
  /** 1 when THIS period's branch is the employee's home/primary branch (owner
   *  2026-07-14). FT monthly salary is paid only at the primary branch so a
   *  cross-branch rotator isn't paid their salary twice; OT + SVC still follow
   *  the branch worked. Defaults to 1 (single-branch = own branch is primary).
   *  Non-branch/legacy callers pass 1 so behaviour is unchanged. */
  is_primary_branch: number;
  /** 1 when THIS period's branch belongs to the employee's home/สังกัด COMPANY
   *  — i.e. the company that registered them for ประกันสังคม (owner 2026-07-29).
   *  ประกันสังคม is withheld by that one employer only, so when a worker helps
   *  at a DIFFERENT company's branch (e.g. พรนภา สังกัด AT HOME ไปช่วย NAMA/EMIA)
   *  this is 0 → no SSO deducted there; their home employer already sends it.
   *  Compared at the COMPANY level (not branch) so same-company multi-branch
   *  rotation (NAMA+HYPO under one company) still deducts SSO everywhere it did
   *  before. Defaults to 1 (single-company / branch-in-home-company / legacy
   *  NULL-branch periods) so behaviour is unchanged for everyone else. */
  is_home_company: number;
  /** วันเริ่มงาน (YYYY-MM-DD) — used to prorate the FT hire month. null = unknown
   *  → no proration (full salary, legacy behaviour). */
  hire_date: string | null;
  /** วันทำงานวันสุดท้าย (YYYY-MM-DD) — approved resignation `proposed_last_day` or
   *  termination `effective_date` — used to prorate the FT resignation month.
   *  null = still employed → no proration. */
  last_working_day: string | null;
  /** วันเริ่มเป็นพนักงานประจำ (YYYY-MM-DD) — the PT→FT transition date. Drives the
   *  transition month = weekly, later months = monthly decision PER PERIOD (see
   *  ftEffectiveCycle), so it computes correctly whether the period is paid in
   *  real time or backfilled. null = legacy FT (always monthly). */
  ft_started_at: string | null;
  /** วันเริ่มเป็นพาร์ทไทม์ (YYYY-MM-DD) — the FT→PT switch date (owner 2026-08-31).
   *  Clean month boundary: the pay engine treats the employee as PART-TIME
   *  (hourly; from the roster when they don't clock) for periods in/after this
   *  date's month, and as FULL-TIME (salary) before it. The stored
   *  employment_type stays 'ft' so they keep running in the monthly cycle;
   *  hourly_rate holds the PT rate. null = not converting. */
  pt_started_at?: string | null;
  /** ค่าจ้างช่วยงานรายวัน (บาท/วัน) ของสาขานี้ (owner 2026-08-17). Set on the host
   *  branch's user_branches row for a CROSS-COMPANY/BRANCH helper (e.g. an FT from
   *  another company who comes to help). When non-null for THIS period's branch the
   *  person is paid as a day-rate helper: base = daily_rate × วันที่มีลงเวลา, WHT 3%
   *  by the paying company, no SSO — overriding their own hourly/salary for this
   *  branch's round. null/undefined (the default) = not a helper here → unchanged. */
  daily_rate?: number | null;
  /** RAW per-branch hourly rate at THIS branch (no fallback to the default rate) —
   *  owner 2026-08-18. Set on an FT's non-home branch, it marks an "hourly helper":
   *  paid by the hour like a PT there. null/undefined = not set. */
  branch_hourly_rate?: number | null;
  /** วันที่จ่ายเงินเดือนช่วงเปลี่ยนผ่านครบแล้วถึง (YYYY-MM-DD) — owner 2026-08-18. For a
   *  PT→FT transition employee whose transition-month salary was already settled by
   *  the retired weekly (÷weeks) method, a later weekly round must NOT re-pay the
   *  base for transition-month days on/before this date (OT + double-pay premium
   *  still pay). null = no already-paid days → normal salary/30 × days. */
  ft_salary_paid_through?: string | null;
  /** วันเริ่มรับค่าตอบแทนแพทย์ (YYYY-MM-DD) — the Doctor Fee switch (owner 2026-08).
   *  From this date's calendar month a doctor no longer earns ค่าเวร (base/OT/SVC
   *  all zero); instead they earn a Doctor Fee — a % of the clinic's HSC revenue
   *  on their rostered days, computed for THIS period's range and added as a
   *  post-tax addition (no withholding for now). null = not on DF. */
  df_started_at?: string | null;
};

/** Which cycle an FT employee is paid on FOR A GIVEN PERIOD (owner 2026-07-16).
 *  The transition month (period month === ft_started_at month) is paid weekly
 *  (fix-rate); every later month is monthly. Derived from ft_started_at + the
 *  period's month — NOT the wall-clock-flipped `users.pay_cycle` flag — so a
 *  backfilled past month lands in the same table it would have in real time.
 *  Legacy FT (no ft_started_at) fall back to their stored pay_cycle (monthly). */
export function ftEffectiveCycle(
  ftStartedAt: string | null,
  storedPayCycle: "weekly" | "monthly" | null,
  periodMonth: string // "YYYY-MM"
): "weekly" | "monthly" {
  if (!ftStartedAt) return storedPayCycle === "weekly" ? "weekly" : "monthly";
  const startMonth = ftStartedAt.slice(0, 7);
  if (startMonth < periodMonth) return "monthly";  // past the transition month
  return "weekly";                                 // transition month (===) or not-yet-FT (>)
}

// SQL fragment (correlated subqueries on `users.id`) that yields the two
// possible last-working-day sources; callers combine them with earliestDate().
const LAST_WORKING_DAY_SELECT = `
  (SELECT MAX(proposed_last_day) FROM resignation_requests
     WHERE user_id = users.id AND status = 'approved') AS resign_last_day,
  (SELECT MAX(effective_date) FROM termination_records
     WHERE user_id = users.id AND status IN ('scheduled','executed')) AS term_last_day`;

type StaffRawRow = Omit<EmployeePayrollSnapshot, "last_working_day"> & {
  resign_last_day: string | null;
  term_last_day: string | null;
};

// PT premium multiplier on public holidays (per company rule)
export const PT_HOLIDAY_MULTIPLIER = 1.5;

// Per-branch PT rate (owner 2026-08-04): a staffer who works several branches can
// earn a different hourly rate at each. When a period is scoped to a branch, use
// that branch's user_branches.hourly_rate if set, else fall back to the
// employee's default users.hourly_rate. Returns a SQL fragment that selects the
// resolved rate AS hourly_rate. branchId must be a trusted integer (a periods
// row's branch_id), inlined because the loaders bind positionally. Company-wide
// / legacy NULL-branch periods (branchId == null) just use the default rate.
export function branchHourlyRateSelect(branchId: number | null): string {
  return branchId != null
    ? `COALESCE((SELECT ub.hourly_rate FROM user_branches ub
                 WHERE ub.user_id = users.id AND ub.branch_id = ${branchId}
                   AND ub.hourly_rate IS NOT NULL), hourly_rate) AS hourly_rate`
    : "hourly_rate";
}

// Cross-company/branch HELPER day rate (owner 2026-08-17). Selects the host
// branch's user_branches.daily_rate for `users.id`, or NULL when this period has
// no branch (legacy all-branches periods never treat anyone as a helper).
// branchId must be a trusted integer (a periods row's branch_id), inlined like
// branchHourlyRateSelect because the loaders bind positionally.
export function branchDailyRateSelect(branchId: number | null): string {
  return branchId != null
    ? `(SELECT ub.daily_rate FROM user_branches ub
         WHERE ub.user_id = users.id AND ub.branch_id = ${branchId}) AS daily_rate`
    : "NULL AS daily_rate";
}

// RAW per-branch hourly rate — NO fallback to users.hourly_rate (owner 2026-08-18).
// Distinct from branchHourlyRateSelect (which COALESCEs to the default) because
// the presence of a per-branch hourly rate on an FT is the signal "pay this
// cross-company helper by the hour here", and a default rate must not trip it.
export function branchOnlyHourlyRateSelect(branchId: number | null): string {
  return branchId != null
    ? `(SELECT ub.hourly_rate FROM user_branches ub
         WHERE ub.user_id = users.id AND ub.branch_id = ${branchId}) AS branch_hourly_rate`
    : "NULL AS branch_hourly_rate";
}

/** is_helper column values (owner 2026-08-18): 0 = normal line, 1 = day-rate
 *  helper (flat/day), 2 = hourly helper (paid by the hour via the PT engine). */
export const HELPER_DAILY = 1;
export const HELPER_HOURLY = 2;

/** How a person is paid at THIS period's branch, if they're a cross-company/branch
 *  helper there (owner 2026-08-18):
 *   - 'daily'  : a positive daily_rate → flat fee per day-with-a-clock-in.
 *   - 'hourly' : an FT (paid elsewhere) with a per-branch hourly rate at a
 *                NON-home branch → paid by the hour like a PT (OT + วันพิเศษ×1.5),
 *                WHT 3% by the paying company, no SSO. (A real PT is already in the
 *                weekly round and paid hourly by the normal path — not a helper.)
 *   - null     : not a helper here → normal salary/hourly engine. */
export function helperMode(emp: EmployeePayrollSnapshot): "daily" | "hourly" | null {
  if (emp.daily_rate != null && emp.daily_rate > 0) return "daily";
  if (emp.employment_type === "ft" && emp.is_primary_branch === 0 &&
      emp.branch_hourly_rate != null && emp.branch_hourly_rate > 0) return "hourly";
  return null;
}

/** Cast an hourly helper's snapshot so the PT hourly engine computes them: paid
 *  by the hour at the per-branch rate, weekly cycle. PT semantics already give
 *  WHT 3% + no SSO, so no tax special-casing is needed downstream. */
export function asHourlyHelper(emp: EmployeePayrollSnapshot): EmployeePayrollSnapshot {
  return {
    ...emp,
    employment_type: "pt",
    hourly_rate: emp.branch_hourly_rate ?? null,
    monthly_salary: null,
    pay_cycle: "weekly",
    daily_rate: null,
    // WHT 3% by the paying company, never SSO here — set explicitly so callers that
    // derive tax from the snapshot (recomputeLine) agree with the PT engine.
    salary_tax_mode: "wht",
    is_home_company: 0
  };
}

// Distinct Bangkok-local dates on which the worker has at least one clock-IN
// among these entries (owner 2026-08-17). A helper earns one day rate per day
// they showed up, regardless of hours worked. Entries are already branch-scoped
// by the caller (keepEntryForBranch), so this counts clock-ins at the host branch.
export function countClockInDays(entries: Array<{ ts: string; type: string }>): number {
  const days = new Set<string>();
  for (const e of entries) {
    if (e.type !== "in") continue;
    // ts is an ISO instant; +7h → the Bangkok wall-clock date it belongs to.
    days.add(new Date(new Date(e.ts).getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10));
  }
  return days.size;
}

/** Compute a cross-company/branch day-rate HELPER line (owner 2026-08-17).
 *  base_pay = daily_rate × days-with-a-clock-in; WHT 3% withheld by the PAYING
 *  company (the host branch's company), NO ประกันสังคม here (their home employer
 *  withholds it). No OT, no service charge — a flat daily fee for helping. The
 *  line is flagged is_helper=1 so the UI shows "ช่วยงานรายวัน N วัน". */
export function computeHelperLine(args: {
  employee: EmployeePayrollSnapshot;
  clockInDays: number;
  settings: PayrollSettings;
}): ComputedLine {
  const { employee: e, clockInDays, settings } = args;
  const rate = e.daily_rate ?? 0;
  const days = clockInDays;
  const base = round2(rate * days);
  // Paying company withholds WHT 3% (owner 2026-08-17: "คนหักภาษี = บริษัทผู้จ่าย").
  const tax = base > 0 ? computeWht(base, settings) : 0;
  const gross = base;
  const net = round2(gross - tax);
  return {
    user_id: e.user_id,
    employee_code: e.employee_code,
    display_name: e.display_name,
    employment_type: e.employment_type,
    pay_cycle_snapshot: "weekly",
    hourly_rate_snapshot: null,
    monthly_salary_snapshot: null,
    salary_tax_mode_snapshot: "wht",
    shift_minutes: 0,
    break_deducted_minutes: 0,
    regular_minutes: 0,
    ot_minutes: 0,
    holiday_minutes: 0,
    days_worked: days,
    leave_days: 0,
    unpaid_leave_days: 0,
    unpaid_leave_deduction: 0,
    unpaired_clockins: 0,
    base_pay: base,
    ot_pay: 0,
    service_charge: 0,
    other_additions: 0,
    gross_pay: gross,
    sso_amount: 0,
    tax_amount: round2(tax),
    other_deductions: 0,
    net_pay: net,
    is_helper: 1
  };
}

export type ComputedLine = {
  user_id: number;
  // snapshots
  employee_code: string | null;
  display_name: string;
  employment_type: "pt" | "ft" | null;
  pay_cycle_snapshot: "weekly" | "monthly" | null;
  hourly_rate_snapshot: number | null;
  monthly_salary_snapshot: number | null;
  salary_tax_mode_snapshot: "sso" | "wht" | null;
  // time
  shift_minutes: number;
  break_deducted_minutes: number;
  regular_minutes: number;
  ot_minutes: number;
  holiday_minutes: number;
  days_worked: number;
  leave_days: number;
  // ลาไม่รับค่าจ้าง — days, and the baht deducted (salary/30 × days, FT only).
  unpaid_leave_days: number;
  unpaid_leave_deduction: number;
  unpaired_clockins: number;
  // pay
  base_pay: number;
  ot_pay: number;
  service_charge: number;
  other_additions: number;
  gross_pay: number;
  sso_amount: number;
  tax_amount: number;
  other_deductions: number;
  net_pay: number;
  /** 1 = cross-company/branch day-rate helper line (owner 2026-08-17). Optional so
   *  the normal compute paths that don't set it stay valid; treated as 0 at insert. */
  is_helper?: number;
};

// ── Time helpers ────────────────────────────────────────────────────

const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;

function bkkDate(iso: string): string {
  return new Date(new Date(iso).getTime() + BKK_OFFSET_MS).toISOString().slice(0, 10);
}

// Count Mondays in a calendar month containing the given date
export function countMondaysInMonth(dateInMonth: string): number {
  // dateInMonth: YYYY-MM-DD
  const [y, m] = dateInMonth.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let n = 0;
  for (let d = 1; d <= lastDay; d++) {
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (dow === 1) n++;
  }
  return n;
}

// ── Shift aggregation ───────────────────────────────────────────────

type Entry = { user_id: number; ts: string; type: "in" | "out" };

export type Shift = { startTs: string; endTs: string; durationMinutes: number };

/** Synthetic shifts from the ROSTER (owner 2026-08-31) — for a no-clock part-timer
 *  whose hours come from the scheduled กะ, not a time-clock. Each scheduled shift
 *  in the period becomes a Shift filling its exact window, so the normal pay loop
 *  (grace clamp → break → regular/OT split → PT pay) then credits scheduled hours
 *  minus the scheduled break. */
export function rosterShifts(
  scheduledByDate: Map<string, ScheduledShift[]>, periodStart: string, periodEnd: string
): Shift[] {
  const out: Shift[] = [];
  for (const [date, list] of scheduledByDate) {
    if (date < periodStart || date > periodEnd) continue;
    for (const s of list) {
      const dur = Math.max(0, Math.round((Date.parse(s.endTs) - Date.parse(s.startTs)) / 60000));
      if (dur > 0) out.push({ startTs: s.startTs, endTs: s.endTs, durationMinutes: dur });
    }
  }
  return out.sort((a, b) => (a.startTs < b.startTs ? -1 : 1));
}

// YYYY-MM-DD + 1 calendar day (UTC-safe; dates are date-only strings).
function addDayYmd(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Last calendar day of the month containing `ymd` (YYYY-MM-DD). Used to keep a
// weekly transition round from paying an FT for days that fall in the NEXT month
// (owner 2026-08-18) — those defer to that month's monthly round.
function endOfMonthYmd(ymd: string): string {
  const [y, m] = ymd.split("-").map(Number);
  // Date.UTC month is 0-indexed, so month index `m` = the month AFTER; day 0 of it
  // is the last day of month `m` (1-indexed).
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

// ── Per-day branch reattribution (payroll_day_branch) ─────────────────
// A raw time-clock punch, plus the branch it should be BOOKED to. When an
// admin moves a day to another branch (owner 2026-07-31: ช่วยไฮโปทั้งวัน แต่
// ลงเวลานามะ), the day's worked time must leave the punched branch's period
// and land in the chosen branch's period. Payroll is one period per branch,
// so we decide, per (user, day), the "effective branch" and keep the punch in
// a period only when that effective branch matches the period's branch.
export type EntryWithBranch = Entry & { id: number; branch_id: number | null };

// (user_id|work_date) → chosen branch_id. Loaded once per compute.
export function loadDayBranchMap(
  db: Database.Database, fromDate: string, toDate: string
): Map<string, number> {
  const rows = db.prepare(
    `SELECT user_id, work_date, branch_id FROM payroll_day_branch
     WHERE work_date >= ? AND work_date <= ?`
  ).all(fromDate, toDate) as Array<{ user_id: number; work_date: string; branch_id: number }>;
  const m = new Map<string, number>();
  for (const r of rows) m.set(`${r.user_id}|${r.work_date}`, r.branch_id);
  return m;
}

// Keep an entry in the period of `branchId` when its EFFECTIVE branch matches.
// Effective branch = the (user,day) reattribution when set, else the punch's
// own branch. A punch belongs to its own branch. An approved time-certification
// whose branch stamp is UNKNOWN (NULL) is still included so certified time is
// never dropped (owner 2026-06-15) — but a cert stamped with a KNOWN branch
// stays in THAT branch only. Including a known-HYPO cert in NAMA's period too
// double-counted a cross-branch worker's day across both branches' books (owner
// 2026-08-01: ศรุตา — นามะ+ไฮโป รวมกันเกินยอดจริง); move a mis-stamped day with
// the per-day branch reattribution instead. Reattribution keys on the punch's
// OWN BKK local date — for the ordinary same-day shift this moves the clock-in
// AND clock-out together. (A cross-midnight shift is out of scope: its two
// punches fall on different dates, so only same-day moves are supported.)
// Legacy NULL-branch periods (branchId == null) keep the old all-branches
// behaviour: nothing is filtered.
export function keepEntryForBranch(
  e: EntryWithBranch, branchId: number | null,
  dayBranch: Map<string, number>, certIds: Set<number>
): boolean {
  if (branchId == null) return true;
  const reass = dayBranch.get(`${e.user_id}|${bkkDate(e.ts)}`);
  if (reass != null) return reass === branchId;
  return e.branch_id === branchId || (e.branch_id == null && certIds.has(e.id));
}

/**
 * Pair clock-in / clock-out events into shifts. Discards unpaired ins.
 * Returns shifts + count of unpaired (still-open) clock-ins.
 */
export function pairShifts(entries: Entry[]): { shifts: Shift[]; unpaired: number } {
  const sorted = [...entries].sort((a, b) => a.ts.localeCompare(b.ts));
  const shifts: Shift[] = [];
  let unpaired = 0;
  let openIn: string | null = null;

  for (const e of sorted) {
    if (e.type === "in") {
      if (openIn !== null) unpaired++;
      openIn = e.ts;
    } else {
      if (openIn !== null) {
        // Whole-minute precision (seconds are ignored) — keeps pay
        // deterministic and consistent with the minute-based editor.
        const dur =
          Math.floor(new Date(e.ts).getTime() / 60000) -
          Math.floor(new Date(openIn).getTime() / 60000);
        if (dur > 0) shifts.push({ startTs: openIn, endTs: e.ts, durationMinutes: dur });
        openIn = null;
      }
    }
  }
  if (openIn !== null) unpaired++;
  return { shifts, unpaired };
}

// ── PT grace window vs scheduled shift ──────────────────────────────
//
// Part-time pay is anchored to the SCHEDULED shift, not the raw clock.
// Owner rule (2026-06-02):
//   • clock-in ≤ 5 min AFTER scheduled start  → treat as on-time (use start)
//   • clock-in BEFORE scheduled start (early)  → no pay before start (use start)
//   • clock-in > 5 min after start (late)      → pay from actual clock-in
//   • clock-out ≤ 5 min BEFORE scheduled end   → treat as full (use end)
//   • clock-out AFTER scheduled end (overtime) → cap at end (OT handled
//                                                separately, not auto-derived)
//   • clock-out > 5 min before end (early out) → pay to actual clock-out
//
// In short: pay is capped to the shift box [start, end], with a ±5-min
// grace at each boundary. Applies to PT only (FT base is salary).

export const PT_GRACE_MINUTES = 5;

// A scheduled shift window for one (user, date), as UTC ISO strings.
// breakStartTs/breakEndTs is the gate's lunch/break window (shift_codes
// break_start/break_end). When present, the overlap with the worked
// window is deducted as unpaid break — "หักเวลาพักตามกะ".
export type ScheduledShift = {
  startTs: string;
  endTs: string;
  breakStartTs?: string | null;
  breakEndTs?: string | null;
};

// ── Shift-swap overlay (owner 2026-06-08) ────────────────────────────
// An informal swap confirmed at clock-in (น้องฮูก) stores the friend's
// shift window in shift_swap_overrides. We treat it as a roster OVERLAY:
// the day's scheduled window becomes the friend's shift, so PT grace +
// pay are computed against the shift actually worked. Admin per-day
// overrides (payroll_line_days.sched_in/out) are applied AFTER this in
// computeLineForEmployee, so they still take precedence.

/** Build a ScheduledShift from a friend's HH:MM window on a date. */
function swapShiftWindow(workDate: string, schedIn: string, schedOut: string): ScheduledShift | null {
  if (!schedIn || !schedOut || schedIn === schedOut) return null;
  const startTs = new Date(`${workDate}T${schedIn}:00+07:00`).toISOString();
  const endDate = schedOut < schedIn ? addDayYmd(workDate) : workDate;
  const endTs = new Date(`${endDate}T${schedOut}:00+07:00`).toISOString();
  return { startTs, endTs, breakStartTs: null, breakEndTs: null };
}

/** Replace the scheduled window for any swapped day in [from,to] for one
 *  user with the friend's shift. Mutates `scheduledByDate` in place. */
export function overlaySwapShifts(
  db: Database.Database, userId: number, fromDate: string, toDate: string,
  scheduledByDate: Map<string, ScheduledShift[]>
): void {
  const rows = db.prepare(`
    SELECT work_date, sched_in, sched_out FROM shift_swap_overrides
    WHERE user_id = ? AND work_date >= ? AND work_date <= ?
  `).all(userId, fromDate, toDate) as Array<{ work_date: string; sched_in: string; sched_out: string }>;
  for (const r of rows) {
    const sh = swapShiftWindow(r.work_date, r.sched_in, r.sched_out);
    if (sh) scheduledByDate.set(r.work_date, [sh]);
  }
}

export type GracedShift = {
  startTs: string;        // effective in (UTC ISO)
  endTs: string;          // effective out (UTC ISO)
  grossMinutes: number;   // effective window length, before break
  breakMinutes: number;   // scheduled break overlapping the window (deducted)
  workedMinutes: number;  // grossMinutes − breakMinutes (paid working time)
  lateMinutes: number;    // minutes the clock-in was late beyond grace (0 if on-time/early)
  earlyMinutes: number;   // minutes the clock-out was early beyond grace (0 if full/late)
};

/**
 * Apply the PT clock-time grace + shift-boundary cap to one raw shift,
 * then deduct the scheduled break that falls inside the worked window.
 * When `scheduled` is null (no roster assignment for the day) the raw
 * clock times are returned unchanged with no break — we have no box to
 * clamp against, so the caller falls back to threshold-based deductBreak.
 */
export function applyPtGrace(
  shift: { startTs: string; endTs: string },
  scheduled: ScheduledShift | null,
  // Approved OT: when set, the worked window may EXTEND past the
  // scheduled end up to this time (UTC ISO). The extra minutes become
  // part of workedMinutes; the caller's regular/OT split (8h threshold)
  // then decides regular vs OT rate. Without it, the window caps at the
  // scheduled end as usual.
  otUntilTs?: string | null,
  // Approved EARLY start (mirror of otUntilTs): when set, the worked window may
  // EXTEND before the scheduled start, down to this time (UTC ISO). The extra
  // pre-shift minutes join workedMinutes; the caller's 8h split then credits the
  // over-8h portion as OT. Without it, an early clock-in clamps UP to the
  // scheduled start as usual (early minutes discarded).
  otFromTs?: string | null,
  // owner 2026-08-03: full-time lateness must NOT dock SERVICE-CHARGE minutes
  // (มาสายไม่หัก — เป็นประวัติพิจารณา; the monthly >20% rule stays the only lever).
  // When true, a late-beyond-grace clock-in is credited from the scheduled start
  // like a within-grace arrival, so the worked window isn't shortened. lateMinutes
  // is still reported for history. Only the SVC minute path passes this; payroll
  // and the breakdown display leave it false.
  creditLateAsScheduled?: boolean
): GracedShift {
  // Floor to whole minutes — the clock stores seconds, but pay is
  // reckoned in minutes (matching the HH:MM the editor shows). Without
  // this a clock-in of 11:39:43 counted as 11:39.28 and rounded a
  // minute off the expected figure (owner 2026-06-03).
  const inMs = Math.floor(new Date(shift.startTs).getTime() / 60000) * 60000;
  const outMs = Math.floor(new Date(shift.endTs).getTime() / 60000) * 60000;
  if (!scheduled) {
    const gross = Math.max(0, (outMs - inMs) / 60000);
    return {
      startTs: shift.startTs,
      endTs: shift.endTs,
      grossMinutes: gross,
      breakMinutes: 0,
      workedMinutes: gross,
      lateMinutes: 0,
      earlyMinutes: 0
    };
  }
  const schStart = new Date(scheduled.startTs).getTime();
  const schEnd = new Date(scheduled.endTs).getTime();
  const graceMs = PT_GRACE_MINUTES * 60000;

  // Effective in: an early clock-in normally clamps UP to the scheduled start.
  // An approved early-start lowers that floor to otFromTs (never earlier than
  // the scheduled start when absent), so the extra pre-shift minutes stay in the
  // window — the mirror of the otUntilTs out-cap below. Bounded by the actual
  // clock-in, so approving 10:00 but arriving 10:30 still pays from 10:30.
  const inFloor = otFromTs ? Math.min(schStart, new Date(otFromTs).getTime()) : schStart;
  let effIn: number;
  let lateMinutes = 0;
  if (inMs <= schStart + graceMs) {
    // Within grace. Two sub-cases fold into one clamp (owner rule: มาสายไม่เกิน 5
    // นาที ให้นับเวลาเข้ากะ):
    //   • clocked in LATE-but-within-grace → snap UP to the scheduled start so
    //     those minutes aren't docked (mirrors the out-side snapping to outCap);
    //   • clocked in EARLY → still paid from arrival, but never before inFloor.
    // min(inMs, schStart) caps the late side at schStart; Math.max(…, inFloor)
    // keeps the early/approved-OT floor. The previous code omitted the min(),
    // so an 11:03 punch on an 11:00 shift kept 11:03 and lost 3 paid minutes.
    effIn = Math.max(Math.min(inMs, schStart), inFloor);
  } else {
    lateMinutes = (inMs - schStart) / 60000;
    // Normally a late arrival is paid from the actual punch (docks the window).
    // For FT SVC, credit from the scheduled start instead so lateness doesn't
    // reduce the tip share (owner 2026-08-03) — lateMinutes above is kept as history.
    effIn = creditLateAsScheduled
      ? Math.max(Math.min(inMs, schStart), inFloor)
      : inMs;
  }

  // Effective out: clamp to the out-cap unless early beyond grace. The
  // out-cap is the scheduled end normally, OR an approved OT "until"
  // time when the staff worked past their shift (lets the window extend
  // so the 8h split can credit the excess as OT).
  const outCap = otUntilTs ? Math.max(schEnd, new Date(otUntilTs).getTime()) : schEnd;
  let effOut: number;
  let earlyMinutes = 0;
  if (outMs >= outCap - graceMs) {
    effOut = outCap;
  } else {
    effOut = outMs;
  }
  // "Early" is measured against the SCHEDULED end (status display only).
  if (effOut < schEnd) earlyMinutes = (schEnd - effOut) / 60000;

  const grossMinutes = Math.max(0, (effOut - effIn) / 60000);

  // Deduct the portion of the scheduled break that overlaps the worked
  // window. If the staff left during the break (effOut inside break) we
  // only subtract the overlapping slice — never more than was worked.
  let breakMinutes = 0;
  if (scheduled.breakStartTs && scheduled.breakEndTs) {
    const bS = new Date(scheduled.breakStartTs).getTime();
    const bE = new Date(scheduled.breakEndTs).getTime();
    const overlap = Math.min(effOut, bE) - Math.max(effIn, bS);
    if (overlap > 0) breakMinutes = overlap / 60000;
  }

  return {
    startTs: new Date(effIn).toISOString(),
    endTs: new Date(effOut).toISOString(),
    grossMinutes,
    breakMinutes,
    workedMinutes: Math.max(0, grossMinutes - breakMinutes),
    lateMinutes: Math.max(0, lateMinutes),
    earlyMinutes: Math.max(0, earlyMinutes)
  };
}

/**
 * Pick the scheduled window that best matches an actual shift when a
 * (user, date) has more than one roster assignment — choose the one
 * whose scheduled start is nearest the actual clock-in.
 */
export function pickScheduled(
  candidates: ScheduledShift[],
  shift: { startTs: string }
): ScheduledShift | null {
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  const inMs = new Date(shift.startTs).getTime();
  return candidates.reduce((best, c) =>
    Math.abs(new Date(c.startTs).getTime() - inMs) <
    Math.abs(new Date(best.startTs).getTime() - inMs)
      ? c : best
  );
}

// ── Per-day clock overrides (payroll_line_days) ─────────────────────
//
// An admin can correct a day's clock-in/out inside the payroll modal.
// We store that as a payroll-scoped override (never on time_entries),
// then merge it over the auto time-clock data at compute time: a row
// for (date) wins over whatever the time-clock recorded for that date.

export type DayOverrideRow = {
  work_date: string;        // YYYY-MM-DD (BKK)
  clock_in: string | null;  // 'HH:MM' (BKK local) or NULL
  clock_out: string | null; // 'HH:MM' or NULL
  // Manual holiday / called-in entry (owner 2026-08-03): an admin adds a worked
  // day with no clock punch but fills the scheduled shift window. When there's no
  // clock pair, that window is used as the worked shift so the day counts in pay.
  sched_in?: string | null;
  sched_out?: string | null;
};

// Per-day FIELD overrides — when an admin types a value in the daily
// breakdown, it WINS over the computed one (owner 2026-06-03). Any field
// null = use the computed value.
export type DayFieldOverride = {
  sched_in?: string | null;    // 'HH:MM' override of the gate start
  sched_out?: string | null;   // 'HH:MM' override of the gate end
  break_min?: number | null;   // override break minutes
  worked_min?: number | null;  // override regular working minutes
  ot_min?: number | null;      // (legacy) override OT minutes — superseded by ot_until
  ot_pay?: number | null;      // override OT pay (THB)
  // Approved OT "until" time (HH:MM) — extends the worked window past the
  // scheduled end so the 8h split credits the excess as OT. When null we
  // fall back to the approved ot_requests row for the day.
  ot_until?: string | null;
};

/**
 * Turn per-day override rows into a Map<date, Shift|null>:
 *   • both times present → a Shift (out<in ⇒ overnight, rolls a day)
 *   • either missing      → null  = "this day has no paid shift"
 * The presence of a key (even mapping to null) means the day is
 * admin-controlled and the auto shift for that date must be dropped.
 */
export function overridesToShiftMap(rows: DayOverrideRow[]): Map<string, Shift | null> {
  const m = new Map<string, Shift | null>();
  const mkShift = (date: string, inHHMM: string, outHHMM: string): Shift | null => {
    const startTs = new Date(`${date}T${inHHMM}:00+07:00`).toISOString();
    const endDate = outHHMM < inHHMM ? addDayYmd(date) : date;
    const endTs = new Date(`${endDate}T${outHHMM}:00+07:00`).toISOString();
    const dur = (new Date(endTs).getTime() - new Date(startTs).getTime()) / 60000;
    return dur > 0 ? { startTs, endTs, durationMinutes: dur } : null;
  };
  for (const r of rows) {
    if (r.clock_in && r.clock_out) {
      m.set(r.work_date, mkShift(r.work_date, r.clock_in, r.clock_out));
    } else if (r.sched_in && r.sched_out) {
      // Manual entry with only the scheduled window (no clock punch) → treat the
      // shift as worked so the day is counted (owner 2026-08-03: ลงเวลาวันหยุด
      // แทนพนักงาน). A real clock pair always wins over this.
      m.set(r.work_date, mkShift(r.work_date, r.sched_in, r.sched_out));
    } else {
      m.set(r.work_date, null);
    }
  }
  return m;
}

/**
 * Merge per-day overrides over auto (time-clock-derived) shifts. Any
 * date present in the override map drops the auto shift(s) for that day
 * and substitutes the override's shift (or nothing, when null).
 */
export function mergeDayOverrides(
  autoShifts: Shift[],
  overrideMap: Map<string, Shift | null>
): Shift[] {
  if (overrideMap.size === 0) return autoShifts;
  const result = autoShifts.filter((s) => !overrideMap.has(bkkDate(s.startTs)));
  for (const sh of overrideMap.values()) {
    if (sh) result.push(sh);
  }
  return result;
}

// ── Break deduction ─────────────────────────────────────────────────

export function deductBreak(
  shiftMinutes: number, settings: PayrollSettings
): { workedMinutes: number; deducted: number } {
  if (shiftMinutes >= settings.long_shift_threshold_minutes) {
    const deducted = settings.long_shift_break_minutes;
    return { workedMinutes: Math.max(0, shiftMinutes - deducted), deducted };
  }
  if (shiftMinutes >= settings.break_threshold_minutes) {
    const deducted = settings.break_deduction_minutes;
    return { workedMinutes: Math.max(0, shiftMinutes - deducted), deducted };
  }
  return { workedMinutes: shiftMinutes, deducted: 0 };
}

// ── OT split (anything beyond 8 hr/shift after break) ───────────────

const OT_THRESHOLD_MIN = 480; // 8 hours

export function splitRegularOt(workedMinutes: number): {
  regular: number; ot: number;
} {
  if (workedMinutes > OT_THRESHOLD_MIN) {
    return { regular: OT_THRESHOLD_MIN, ot: workedMinutes - OT_THRESHOLD_MIN };
  }
  return { regular: workedMinutes, ot: 0 };
}

// ── OT pay ──────────────────────────────────────────────────────────

export function computeOtPay(
  otMinutes: number, hourlyRate: number, settings: PayrollSettings,
  multiplier = 1
): number {
  if (otMinutes <= 0) return 0;
  if (settings.ot_mode === "flat") {
    // ทุกๆ 15 นาที = ot_flat_per_15min — round DOWN to nearest 15-min block
    // (ลูกจ้างไม่ได้รับ partial block — กฎของร้าน)
    const blocks = Math.floor(otMinutes / 15);
    return blocks * settings.ot_flat_per_15min * multiplier;
  }
  // legal: 1.5x hourly_rate, prorated by minutes
  return (otMinutes / 60) * hourlyRate * 1.5 * multiplier;
}

// ── SSO (Social Security) — for "in-system" employees ──────────────

/**
 * SSO is a monthly concept (cap 875/month per current Thai SSO ceiling).
 * For weekly periods we pro-rate the cap by period length.
 *
 * IMPORTANT: the base is the WAGE / ฐานเงินเดือน only — NOT gross. OT, service
 * charge and other compensation are excluded by Thai SSO rule (owner 2026-07-04).
 * So callers pass base_pay, not gross_pay.
 */
export function computeSso(
  ssoBase: number,
  cycle: "weekly" | "monthly",
  settings: PayrollSettings
): number {
  if (ssoBase <= 0) return 0;
  const cap = cycle === "weekly" ? settings.sso_cap / 4 : settings.sso_cap;
  const raw = ssoBase * settings.sso_rate;
  return Math.min(raw, cap);
}

// ── WHT (Withholding Tax) — for "out-of-system" employees ──────────

/**
 * Withholding tax for staff who are not in the SSO system.
 * Default rate 3% — flat on gross.
 */
export function computeWht(periodGross: number, settings: PayrollSettings): number {
  if (periodGross <= 0) return 0;
  return periodGross * settings.wht_rate;
}

// ── Thai PIT (Personal Income Tax) ──────────────────────────────────

const PIT_BRACKETS: Array<{ upTo: number; rate: number }> = [
  { upTo: 150_000,   rate: 0    },
  { upTo: 300_000,   rate: 0.05 },
  { upTo: 500_000,   rate: 0.10 },
  { upTo: 750_000,   rate: 0.15 },
  { upTo: 1_000_000, rate: 0.20 },
  { upTo: 2_000_000, rate: 0.25 },
  { upTo: 5_000_000, rate: 0.30 },
  { upTo: Infinity,  rate: 0.35 }
];

export function computeAnnualTax(annualTaxable: number): number {
  let tax = 0;
  let prev = 0;
  for (const b of PIT_BRACKETS) {
    if (annualTaxable <= prev) break;
    const inBracket = Math.min(annualTaxable, b.upTo) - prev;
    tax += inBracket * b.rate;
    prev = b.upTo;
    if (annualTaxable <= b.upTo) break;
  }
  return tax;
}

/**
 * Annualize the period gross + project tax for the period.
 *  - Standard deduction for employment income: 50% of income, max 100k
 *  - Personal allowance: 60k
 *  - SSO deduction: annualized period SSO
 * Then divide annual tax by the number of periods per year.
 */
export function computePeriodTax(
  periodGross: number,
  periodSso: number,
  cycle: "weekly" | "monthly"
): number {
  if (periodGross <= 0) return 0;
  const periodsPerYear = cycle === "weekly" ? 52 : 12;
  const annualGross = periodGross * periodsPerYear;
  const stdDeduction = Math.min(annualGross * 0.5, 100_000);
  const personalAllowance = 60_000;
  const annualSso = periodSso * periodsPerYear;
  const taxable = Math.max(0, annualGross - stdDeduction - personalAllowance - annualSso);
  const annualTax = computeAnnualTax(taxable);
  return annualTax / periodsPerYear;
}

// ── Main compute function ───────────────────────────────────────────

/** True when this period is the employee's FT hire month or resignation month —
 *  a partial-employment month whose FT salary is paid per ACTUAL DAYS WORKED
 *  (attended), at monthly_salary / 30 per day, instead of the full salary
 *  (owner 2026-07-15). Inclusive of the period boundaries: an FT who becomes
 *  permanent from day 1 of the month is still paid per days worked in that first
 *  month ("เข้ามาเป็น FT ตั้งแต่วันแรก เดือนแรก ถ้าทำงานไม่เต็มวัน จะให้รายวันที่
 *  เข้าทำงาน"). A fully-employed month (hired before the period, no resignation in
 *  it) returns false → full salary, so normal months are never attendance-docked. */
export function isFtPartialMonth(
  hireDate: string | null,
  lastDay: string | null,
  periodStart: string,
  periodEnd: string
): boolean {
  const hiredThisPeriod = !!hireDate && hireDate >= periodStart && hireDate <= periodEnd;
  const leftThisPeriod = !!lastDay && lastDay >= periodStart && lastDay <= periodEnd;
  return hiredThisPeriod || leftThisPeriod;
}

/** Calendar days an FT is IN STATUS within [periodStart, periodEnd] inclusive —
 *  from max(startBound, periodStart) to min(endBound || periodEnd, periodEnd).
 *  Drives the daily-rate base of a partial month / weekly transition round (owner
 *  2026-08-03: salary/30 per employed calendar day — weekly offs + paid days count;
 *  only unpaid absences are deducted separately). 0 if the range is empty. */
export function employedCalendarDays(
  startBound: string | null,
  endBound: string | null,
  periodStart: string,
  periodEnd: string
): number {
  const lo = startBound && startBound > periodStart ? startBound : periodStart;
  const hi = endBound && endBound < periodEnd ? endBound : periodEnd;
  if (lo > hi) return 0;
  let n = 0;
  let cur = lo;
  while (cur <= hi) {
    n++;
    const nd = new Date(`${cur}T00:00:00Z`);
    nd.setUTCDate(nd.getUTCDate() + 1);
    cur = nd.toISOString().slice(0, 10);
  }
  return n;
}

/** Earliest non-null of two YYYY-MM-DD dates (or null). */
export function earliestDate(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a < b ? a : b;
}

/** is_home_company flag (owner 2026-07-29) — 1 unless we KNOW this period's
 *  branch is in a DIFFERENT company than the employee's home/สังกัด branch.
 *  ประกันสังคม is withheld only by the home employer, so a cross-company helper
 *  (พรนภา สังกัด AT HOME → ช่วยงาน NAMA/EMIA) gets 0 → no SSO at the other
 *  company. Compared at the COMPANY level so same-company multi-branch rotation
 *  (NAMA+HYPO under one company) is unchanged. Fail-safe: NULL-branch period or
 *  any unknown company_id → 1. Mirrors the SQL homeCompanyExpr in
 *  computePayrollPeriod so real-time and manual/recompute paths agree. */
export function resolveHomeCompanyFlag(
  db: Database.Database, userId: number, periodBranchId: number | null
): number {
  if (periodBranchId == null) return 1;
  const homeBranch = (db.prepare(`
    SELECT COALESCE(
      (SELECT branch_id FROM user_branches WHERE user_id = ? AND is_primary = 1 LIMIT 1),
      (SELECT MIN(branch_id) FROM user_branches WHERE user_id = ?)
    ) AS b
  `).get(userId, userId) as { b: number | null }).b;
  if (homeBranch == null) return 1;
  const companyOf = db.prepare("SELECT company_id AS c FROM branches WHERE id = ?");
  const pc = (companyOf.get(periodBranchId) as { c: number | null } | undefined)?.c ?? null;
  const hc = (companyOf.get(homeBranch) as { c: number | null } | undefined)?.c ?? null;
  return (pc != null && hc != null && pc !== hc) ? 0 : 1;
}

export function computeLineForEmployee(args: {
  employee: EmployeePayrollSnapshot;
  shifts: Shift[];
  unpaired: number;
  leaveDays: number;
  unpaidLeaveDays?: number;
  cycle: "weekly" | "monthly";
  periodStart: string;        // YYYY-MM-DD (used for FT hire/resignation proration)
  periodEnd: string;          // YYYY-MM-DD (used for FT-weekly division)
  // Pay date of the period (YYYY-MM-DD). When a transition-month WEEKLY round pays
  // in a LATER month than the round's own month, the FT base salary is NOT paid in
  // that round — only OT + the double-pay excess are "paid ahead"; the base rolls
  // into the monthly salary paid the 5th of the next month (owner 2026-08-03). Omit
  // → no suppression (back-compat).
  payDate?: string;
  settings: PayrollSettings;
  holidaySet: Set<string>;    // YYYY-MM-DD dates that count as PT premium days (1.5×)
  // วันจ่ายสองเท่า (owner 2026-07-21): dates where EVERY employee earns 2× on both
  // base and OT (FT + PT). 2× wins over the 1.5× holiday premium on the same date.
  doubleSet?: Set<string>;
  // PT grace: scheduled shift windows for this employee, keyed by the
  // BKK calendar date (YYYY-MM-DD) of the assignment. When provided and
  // the employee is part-time, each clocked shift is clamped to its
  // scheduled box ±5-min grace (see applyPtGrace). Omit / leave empty to
  // fall back to raw clock times (legacy behaviour, e.g. no roster).
  scheduledByDate?: Map<string, ScheduledShift[]>;
  // Approved OT requests for this employee, keyed by BKK date → the
  // "requested until" HH:MM. Applies to BOTH PT and FT (owner 2026-06-14).
  // OT minutes credited that day = min(actual clock-out, requested_until) −
  // scheduled end. Requires a scheduled shift (sched) for the date.
  approvedOtByDate?: Map<string, string>;
  // Approved EARLY-start requests → date → "requested_from" HH:MM (mirror of
  // approvedOtByDate). An approved early start lets pre-shift minutes count so
  // the day's over-8h becomes OT (owner 2026-07-28). Requires a scheduled shift.
  approvedEarlyByDate?: Map<string, string>;
  // Per-day FIELD overrides (admin typed a value in the breakdown). Any
  // present field wins over the computed one.
  fieldOverridesByDate?: Map<string, DayFieldOverride>;
  // Approved-leave DATES for this employee in the period (owner 2026-08-03,
  // Phase B). Used to spot no-shows: a scheduled WORK day with no clock-in AND
  // not on this set = ขาดงานไม่ลา → หักเป็นลาไม่รับค่าจ้าง (daily FT groups only).
  leaveDates?: Set<string>;
  // Doctor Fee for THIS period (บาท), pre-computed by the orchestrator from the
  // clinic's HSC revenue × roster for this period's range. 0/undefined = none.
  // Only applied when the employee is on DF (df_started_at active this period)
  // AND this period's branch is the DF (clinic) branch — see dfBranchPeriod.
  dfAmount?: number;
  // True only when THIS period's branch runs Doctor Fee (df_enabled). Gates the
  // ค่าเวร-zeroing so a DF doctor who picks up a shift at another (non-DF) branch
  // is still paid normally there (owner: DF replaces CLINIC pay).
  dfBranchPeriod?: boolean;
}): ComputedLine {
  const { employee: eIn, shifts: shiftsIn, unpaired, leaveDays, unpaidLeaveDays = 0, cycle, periodStart, periodEnd, settings, holidaySet, doubleSet = new Set<string>(), scheduledByDate, approvedOtByDate, approvedEarlyByDate, fieldOverridesByDate, leaveDates, dfAmount = 0, dfBranchPeriod = false } = args;
  // FT→PT switch (owner 2026-08-31): from pt_started_at's calendar month the
  // employee is treated as PART-TIME (hourly), before it as FULL-TIME (salary) —
  // period-relative so backfilled months still compute correctly. The stored
  // employment_type stays 'ft' (keeps them in the monthly run); we flip only the
  // EFFECTIVE type the pay logic branches on.
  const effType: "pt" | "ft" | null =
    eIn.pt_started_at != null && periodStart.slice(0, 7) >= eIn.pt_started_at.slice(0, 7)
      ? "pt" : eIn.employment_type;
  const e: EmployeePayrollSnapshot = effType === eIn.employment_type ? eIn : { ...eIn, employment_type: effType };
  // No-clock part-timer → hours from the ROSTER, not a time-clock (owner
  // 2026-08-31). track_attendance = 0 means "doesn't punch"; for a PT that means
  // the scheduled กะ hours ARE the worked hours.
  const noClockPt = e.employment_type === "pt" && e.track_attendance === 0;
  const shifts = noClockPt && scheduledByDate ? rosterShifts(scheduledByDate, periodStart, periodEnd) : shiftsIn;
  // Extra FT base for double-pay days: FT base is salary (not per-day) so the 2×
  // is credited as one extra day-equivalent (ftHourlyEquivalent × regular hours)
  // per double day worked — added to basePay below (owner 2026-07-21).
  let ftDoubleBonus = 0;

  // Cycle this period pays an FT on — period-relative (transition month = weekly),
  // drives both the base and the forced-WHT tax mode (owner 2026-07-16).
  const ftCycle = ftEffectiveCycle(e.ft_started_at, e.pay_cycle, periodStart.slice(0, 7));

  // Weekly TRANSITION round (owner 2026-08-18): an FT in their PT→FT transition
  // month is paid weekly by day. If this weekly period spills into the NEXT month
  // (where they're already on the monthly cycle), those next-month days must NOT
  // pay here — they belong to that month's monthly round. Drop them from the whole
  // line so base, OT, minutes and days_worked all reflect only the transition-month
  // part. Only for real transition FTs (ft_started_at set) — legacy weekly FTs and
  // full-month FTs are untouched.
  const isTransitionWeekly = e.employment_type === "ft" && e.ft_started_at != null
    && ftCycle === "weekly" && cycle === "weekly";
  const transMonthEnd = isTransitionWeekly ? endOfMonthYmd(periodStart) : null;
  const effShifts = transMonthEnd
    ? shifts.filter((s) => bkkDate(s.startTs) <= transMonthEnd)
    : shifts;

  // Determine effective hourly rate (used for legal OT mode + display)
  const ptRate = e.hourly_rate ?? settings.pt_default_hourly_rate;
  const ftHourlyEquivalent = e.monthly_salary ? e.monthly_salary / 30 / 8 : 0;
  const effectiveHourlyRate =
    e.employment_type === "pt" ? ptRate :
    e.employment_type === "ft" ? ftHourlyEquivalent : 0;

  // Aggregate shift minutes — and per-shift PT pay (with holiday premium)
  let shiftMin = 0;
  let regularMin = 0;
  let otMin = 0;
  let holidayMin = 0;
  let breakDeducted = 0;
  let ptBasePay = 0;
  let ptOtPay = 0;
  let ftOtPay = 0;        // FT also gets OT but no holiday premium
  const daysSet = new Set<string>();

  for (const s of effShifts) {
    const shiftDate = bkkDate(s.startTs);

    // PT: clamp the worked window to the scheduled shift box ±5-min
    // grace (no pay before start / after end; lateness & early-out
    // counted from actuals) AND deduct the scheduled break. FT keeps
    // the raw clock duration since its base pay is salary-driven.
    let grossMin = s.durationMinutes;   // before break (for shift_minutes col)
    let workedMinutes: number;
    let deducted: number;

    const ov = fieldOverridesByDate?.get(shiftDate);

    // Scheduled window — admin per-day override wins over the roster. Used by
    // BOTH PT and FT: the scheduled break + start-grace make the worked hours
    // match the shift (same break for the same กะ). The OT window (otUntilTs
    // below) extends past the scheduled end only for an approved OT request —
    // same rule for PT and FT (owner 2026-07-14).
    let sched = scheduledByDate
      ? pickScheduled(scheduledByDate.get(shiftDate) ?? [], s)
      : null;
    if (ov?.sched_in && ov?.sched_out) {
      const sStart = new Date(`${shiftDate}T${ov.sched_in}:00+07:00`).toISOString();
      const sEndDate = ov.sched_out < ov.sched_in ? addDayYmd(shiftDate) : shiftDate;
      const sEnd = new Date(`${sEndDate}T${ov.sched_out}:00+07:00`).toISOString();
      sched = { startTs: sStart, endTs: sEnd, breakStartTs: sched?.breakStartTs ?? null, breakEndTs: sched?.breakEndTs ?? null };
    }

    // OT is approval-gated for EVERYONE (owner 2026-07-14): time worked past
    // the scheduled end counts as OT only up to an approved OT request's
    // "until" time (or an admin per-day ot_until override). Unapproved
    // over-time is capped at the scheduled end below and never becomes OT, no
    // matter how many minutes. This reverts the 2026-06-18 FT auto-over-8h
    // rule. Salaried execs (track_attendance=0) never get OT.
    // Symmetric early-start OT (owner 2026-07-28): an approved early clock-in
    // lets the window extend BEFORE the scheduled start, so pre-shift minutes
    // that push the day over 8h become OT. otApproved (late OR early) gates
    // whether split.ot is kept below.
    const isExec = e.employment_type === "ft" && e.track_attendance === 0;
    const reqUntil = isExec ? null : (ov?.ot_until ?? approvedOtByDate?.get(shiftDate) ?? null);
    const reqFrom = isExec ? null : (approvedEarlyByDate?.get(shiftDate) ?? null);
    const lateApproved = !!(reqUntil && /^\d{2}:\d{2}$/.test(reqUntil));
    const earlyApproved = !!(reqFrom && /^\d{2}:\d{2}$/.test(reqFrom));
    const otApproved = lateApproved || earlyApproved;
    let otUntilTs: string | null = null;
    let otFromTs: string | null = null;
    if (sched && lateApproved) {
      otUntilTs = new Date(`${shiftDate}T${reqUntil}:00+07:00`).toISOString();
    }
    if (sched && earlyApproved) {
      otFromTs = new Date(`${shiftDate}T${reqFrom}:00+07:00`).toISOString();
    }

    if (sched) {
      const g = applyPtGrace(s, sched, otUntilTs, otFromTs);
      grossMin = g.grossMinutes;
      deducted = g.breakMinutes;
      workedMinutes = g.workedMinutes;
    } else {
      // No roster for this day → raw clock minus the threshold break, so OT
      // is still "actual worked over 8h/day".
      const db = deductBreak(s.durationMinutes, settings);
      workedMinutes = db.workedMinutes;
      deducted = db.deducted;
    }

    // Per-day break override (recompute worked from gross − new break).
    if (ov?.break_min != null) {
      deducted = ov.break_min;
      workedMinutes = Math.max(0, grossMin - ov.break_min);
    }

    shiftMin += grossMin;
    breakDeducted += deducted;
    const split = splitRegularOt(workedMinutes);
    // OT only counts when approved (owner 2026-07-14). With a scheduled shift
    // and no approval the worked window is already capped at the scheduled end
    // (otUntilTs null → applyPtGrace clamps) so split.ot is 0; on an
    // unscheduled day (no cap) we zero it here and the reclassification below
    // rolls the over-8h into regular. Per-day overrides still win.
    const autoOt = otApproved ? split.ot : 0;
    // Per-day overrides of the final regular / OT minutes win over the
    // computed split.
    const dayRegular = ov?.worked_min != null ? ov.worked_min : split.regular + (split.ot - autoOt);
    const dayOt = ov?.ot_min != null ? ov.ot_min : autoOt;
    regularMin += dayRegular;
    otMin += dayOt;

    daysSet.add(shiftDate);
    const isHoliday = holidaySet.has(shiftDate);
    const isDouble = doubleSet.has(shiftDate);

    if (isHoliday) {
      holidayMin += dayRegular + dayOt;
    }

    // Per-shift pay computation
    if (e.employment_type === "pt") {
      // PT premium: 2× on a double-pay day, else 1.5× on a วันพิเศษ, else 1× —
      // applied to both base + OT (owner 2026-07-21: 2× wins over the 1.5×).
      const mult = isDouble ? 2 : isHoliday ? PT_HOLIDAY_MULTIPLIER : 1;
      ptBasePay += (dayRegular / 60) * ptRate * mult;
      // ค่าล่วงเวลา override (typed baht) wins over the computed OT pay.
      ptOtPay += ov?.ot_pay != null ? ov.ot_pay : computeOtPay(dayOt, ptRate, settings, mult);
    } else if (e.employment_type === "ft" && e.track_attendance !== 0) {
      // FT: OT only (base is salary), now approval-gated like PT — the
      // roster sched above caps worked at the scheduled end, so OT is the
      // approved-extension excess only (no auto over-8h). A typed ค่าล่วงเวลา
      // override still wins. No 1.5× holiday premium per company rule, BUT a
      // double-pay day gives 2× OT and one extra day-equivalent of base.
      // Salaried execs (track_attendance=0) get no OT (owner 2026-07-12).
      ftOtPay += ov?.ot_pay != null ? ov.ot_pay : computeOtPay(dayOt, ftHourlyEquivalent, settings, isDouble ? 2 : 1);
      if (isDouble) ftDoubleBonus += (dayRegular / 60) * ftHourlyEquivalent;
    }
  }

  // No-show detection (owner 2026-08-03, Phase B) — DAILY FT groups only. A
  // scheduled WORK day (key in scheduledByDate) within the employed range that
  // wasn't clocked (not in daysSet) and isn't covered by approved leave =
  // ขาดงานไม่ลา → หักเป็นลาไม่รับค่าจ้าง (salary/30/day, folded into the unpaid
  // deduction below). Established full-month FT + PT are untouched.
  let noShowDays = 0;
  const countNoShow = (startBound: string | null, endBound: string | null): number => {
    if (!scheduledByDate) return 0;
    const lo = startBound && startBound > periodStart ? startBound : periodStart;
    const hi = endBound && endBound < periodEnd ? endBound : periodEnd;
    let n = 0;
    for (const d of scheduledByDate.keys()) {
      if (d >= lo && d <= hi && !daysSet.has(d) && !leaveDates?.has(d)) n++;
    }
    return n;
  };

  // Base pay
  let basePay = 0;
  if (e.employment_type === "pt") {
    basePay = ptBasePay;
  } else if (e.employment_type === "ft") {
    // FT: salary regardless of clock — but only included in matching cycle AND
    // only at the employee's home/primary branch, so a cross-branch rotator
    // isn't paid their full salary in every branch's period (owner 2026-07-14).
    // Their OT + service charge at the non-primary branch still pay there.
    if (ftCycle === cycle && e.monthly_salary && e.is_primary_branch !== 0) {
      if (cycle === "monthly") {
        basePay = e.monthly_salary;
        // Hire / resignation month → daily rate: salary/30 × calendar days IN
        // STATUS this period (owner 2026-08-03 — เข้าต้นเดือนทำเต็มเดือน = เต็ม;
        // เข้ากลางเดือน = ตามวันที่อยู่จริง). Weekly offs + paid days count; unpaid
        // absences are deducted below. Capped at full salary. Full months untouched.
        if (isFtPartialMonth(e.hire_date, e.last_working_day, periodStart, periodEnd)) {
          const empDays = employedCalendarDays(e.hire_date, e.last_working_day, periodStart, periodEnd);
          basePay = Math.min(e.monthly_salary, round2((e.monthly_salary / 30) * empDays));
          noShowDays = countNoShow(e.hire_date, e.last_working_day);
        }
      } else {
        // Weekly transition month (owner 2026-08-03): daily rate salary/30 × calendar
        // days in FT status this round (from ft_started_at). Two boundary rules
        // (owner 2026-08-18):
        //   A) don't pay for days in the NEXT month — cap the window at the
        //      transition-month end; those days defer to that month's monthly round.
        //   B) don't re-pay transition-month days already settled by the retired
        //      weekly (÷weeks) method — start the base window after
        //      ft_salary_paid_through. OT + double-pay premium for those days still
        //      pay (they're computed per-shift above, not from this base window).
        const ftStart = e.ft_started_at ?? e.hire_date;
        const baseEnd = transMonthEnd && periodEnd > transMonthEnd ? transMonthEnd : periodEnd; // Rule A
        let baseStart = ftStart;                                                                 // Rule B
        if (e.ft_salary_paid_through) {
          const after = addDayYmd(e.ft_salary_paid_through);
          if (!baseStart || after > baseStart) baseStart = after;
        }
        const empDays = employedCalendarDays(baseStart, e.last_working_day, periodStart, baseEnd);
        basePay = round2((e.monthly_salary / 30) * empDays);
        noShowDays = countNoShow(baseStart, earliestDate(e.last_working_day, baseEnd));
      }
    }
    // Else: different pay_cycle than this period, or not the primary branch — exclude
  }

  // ลาไม่รับค่าจ้าง (+ ขาดงานไม่ลา, Phase B) — reduce FT base by salary/30 per day.
  const totalUnpaidDays = unpaidLeaveDays + noShowDays;
  const ulDeduction = unpaidLeaveDeduction(e, totalUnpaidDays, basePay);
  // FT วันจ่ายสองเท่า premium no longer inflates ฐานเงินเดือน (owner 2026-09-02:
  // "จ่ายสองเท่า ส่วนที่เพิ่มขึ้นมาให้ไปใส่ช่องเพิ่มอื่นๆ"). It is carried in
  // other_additions below and kept in the tax base, so ภาษีคิดที่ยอดรวม while
  // ประกันสังคมคิดที่ฐานเงินเดือน. (ftDoubleBonus is 0 for PT — its 2× is baked
  // into ptBasePay via the multiplier.)
  basePay = round2(basePay - ulDeduction);

  // Total OT pay
  let otPay = e.employment_type === "pt" ? ptOtPay : ftOtPay;

  // Service charge — Phase C4 (filled later)
  let serviceCharge = 0;

  // Doctor Fee (DF) — owner 2026-08. From df_started_at's calendar month the
  // doctor stops earning ค่าเวร: zero base/OT/SVC and pay the Doctor Fee instead,
  // carried in other_additions. dfAmount is this period's fee (computed by the
  // orchestrator from the clinic HSC revenue × roster for the period range), so
  // it works for a weekly OR a monthly period. Post-tax — no withholding for now.
  const dfActive = dfBranchPeriod && eIn.df_started_at != null && periodStart.slice(0, 7) >= eIn.df_started_at.slice(0, 7);
  if (dfActive) { basePay = 0; otPay = 0; serviceCharge = 0; }
  // other_additions holds two mutually-exclusive kinds of extra pay:
  //   • วันจ่ายสองเท่า premium (owner 2026-09-02) — TAXABLE, so it stays in the
  //     tax base; ประกันสังคม stays on base salary only. Non-DF FT only.
  //   • Doctor Fee (DF) — POST-TAX (no withholding for now). DF zeroes base/OT/SVC,
  //     so the double-pay premium is 0 for a DF doctor; the two never co-occur.
  const doublePayBonus = dfActive ? 0 : round2(Math.max(0, ftDoubleBonus));
  const dfAddition = dfActive ? round2(Math.max(0, dfAmount)) : 0;
  const otherAdditions = round2(dfAddition + doublePayBonus);

  // Tax base = base + OT + service charge + the taxable double-pay premium
  // (ภาษีคิดที่ยอดรวม). The doctor fee is the only post-tax addition — excluded.
  const taxableGross = basePay + otPay + serviceCharge + doublePayBonus;
  const grossPay = taxableGross + dfAddition;

  // Tax & SSO based on employee's salary_tax_mode
  // 'sso' = ในระบบ → SSO 5% (cap) only — PIT is not withheld monthly
  //                  (handled annually between employee & Revenue Dept)
  // 'wht' = นอกระบบ → WHT 3% flat on gross, no SSO
  // Tax mode BY GROUP (owner 2026-08-03, refined 2026-09-02):
  //   - พาร์ทไทม์ → หัก ณ ที่จ่าย 3% (WHT) เสมอ
  //   - ประจำ เดือนเปลี่ยนผ่าน (weekly cycle) / เดือนแรกที่เพิ่งเข้า → WHT
  //     (ยังไม่ทันขึ้นทะเบียนประกันสังคม)
  //   - ประจำ เต็มเดือน → ยึด salary_tax_mode รายคน (owner 2026-09-02: บางคน
  //     อยู่นอกระบบต้อง WHT — ไม่ใช่พนักงานประจำทุกคนเข้าประกันสังคม). ระบบเดิม
  //     บังคับ SSO ทุกคน ทำให้คนนอกระบบถูกหักประกันสังคมผิด.
  //   - อื่นๆ (df) → ยึด salary_tax_mode รายคน
  const ftStartForTax = e.ft_started_at ?? e.hire_date;
  const isFtFirstMonth = !!ftStartForTax && ftStartForTax >= periodStart && ftStartForTax <= periodEnd;
  const taxMode =
    e.employment_type === "pt" ? "wht"
    : e.employment_type === "ft"
      ? ((ftCycle === "weekly" || isFtFirstMonth) ? "wht" : (e.salary_tax_mode ?? "sso"))
      : (e.salary_tax_mode ?? "sso");
  let ssoAmount = 0;
  let taxAmount = 0;
  if (taxableGross > 0) {
    if (taxMode === "wht") {
      taxAmount = computeWht(taxableGross, settings);
    } else if (e.is_home_company !== 0) {
      ssoAmount = computeSso(basePay, cycle, settings); // SSO on base salary only
    }
    // else: cross-company helper — ประกันสังคม is withheld by their home
    // employer only, so a different company's branch deducts nothing here.
  }

  const otherDeductions = 0;
  const netPay = grossPay - ssoAmount - taxAmount - otherDeductions;

  return {
    user_id: e.user_id,
    employee_code: e.employee_code,
    display_name: e.display_name,
    employment_type: e.employment_type,
    pay_cycle_snapshot: e.pay_cycle,
    hourly_rate_snapshot: e.hourly_rate,
    monthly_salary_snapshot: e.monthly_salary,
    salary_tax_mode_snapshot: taxMode,
    shift_minutes: Math.round(shiftMin),
    break_deducted_minutes: Math.round(breakDeducted),
    regular_minutes: Math.round(regularMin),
    ot_minutes: Math.round(otMin),
    holiday_minutes: Math.round(holidayMin),
    days_worked: daysSet.size,
    leave_days: leaveDays,
    unpaid_leave_days: totalUnpaidDays,
    unpaid_leave_deduction: round2(ulDeduction),
    unpaired_clockins: unpaired,
    base_pay: round2(basePay),
    ot_pay: round2(otPay),
    service_charge: round2(serviceCharge),
    other_additions: round2(otherAdditions),
    gross_pay: round2(grossPay),
    sso_amount: round2(ssoAmount),
    tax_amount: round2(taxAmount),
    other_deductions: round2(otherDeductions),
    net_pay: round2(netPay)
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** ลาไม่รับค่าจ้าง deduction: salary/30 per day, FT only (a PT's unpaid
 *  leave is already no-shift = no pay, so nothing to deduct). Clamped so it
 *  never drives base pay below zero. owner 2026-06-17. */
function unpaidLeaveDeduction(e: EmployeePayrollSnapshot, days: number, base: number): number {
  if (e.employment_type !== "ft" || !e.monthly_salary || days <= 0) return 0;
  return Math.min(round2((e.monthly_salary / 30) * days), round2(base));
}

/**
 * Recompute pay components from manually-entered minute totals.
 * Used when an admin edits a payroll line's hours/days directly (no shift data).
 *
 * holiday_minutes is the subset of (regular + ot) minutes that fell on holidays.
 * It is split proportionally between regular and ot — same multiplier (1.5×)
 * as the auto-computed flow.
 */
export function computeLineFromMinutes(args: {
  employee: EmployeePayrollSnapshot;
  regularMinutes: number;
  otMinutes: number;
  holidayMinutes: number;
  leaveDays: number;
  unpaidLeaveDays?: number;
  daysWorked: number;
  unpaired: number;
  cycle: "weekly" | "monthly";
  periodStart: string;
  periodEnd: string;
  // See computeLineForEmployee.payDate — suppress the FT weekly base when the
  // transition-month round pays in a later month (owner 2026-08-03).
  payDate?: string;
  settings: PayrollSettings;
  serviceCharge?: number;
  otherAdditions?: number;
  otherDeductions?: number;
  // True only when this period's branch runs Doctor Fee — gates the ค่าเวร-zeroing
  // (mirrors computeLineForEmployee.dfBranchPeriod).
  dfBranchPeriod?: boolean;
}): ComputedLine {
  const {
    employee: eIn, regularMinutes, otMinutes, holidayMinutes, leaveDays,
    unpaidLeaveDays = 0, daysWorked, unpaired, cycle, periodStart, periodEnd, settings,
    serviceCharge: serviceChargeIn = 0, otherAdditions = 0, otherDeductions = 0, dfBranchPeriod = false
  } = args;
  // FT→PT switch (owner 2026-08-31) — mirror computeLineForEmployee so a manually
  // entered/edited line for a post-switch period computes as PART-TIME too.
  const effTypeM: "pt" | "ft" | null =
    eIn.pt_started_at != null && periodStart.slice(0, 7) >= eIn.pt_started_at.slice(0, 7)
      ? "pt" : eIn.employment_type;
  const e: EmployeePayrollSnapshot = effTypeM === eIn.employment_type ? eIn : { ...eIn, employment_type: effTypeM };

  // Doctor Fee (DF) — zero ค่าเวร (base/OT/SVC) once on DF at the DF branch; the
  // fee rides in other_additions, post-tax (mirrors computeLineForEmployee).
  const dfActiveM = dfBranchPeriod && eIn.df_started_at != null && periodStart.slice(0, 7) >= eIn.df_started_at.slice(0, 7);
  const serviceCharge = dfActiveM ? 0 : serviceChargeIn;

  const hMode = helperMode(e);
  // Hourly helper (owner 2026-08-18): pay by the hour like a PT (OT + วันพิเศษ×1.5,
  // WHT 3%, no SSO) — recompute on a PT-cast snapshot, then flag the line.
  if (hMode === "hourly") {
    const pt = computeLineFromMinutes({ ...args, employee: asHourlyHelper(e) });
    // Keep the REAL employment_type; is_helper carries the helper distinction.
    return { ...pt, is_helper: HELPER_HOURLY, employment_type: e.employment_type };
  }
  // Cross-company/branch day-rate helper (owner 2026-08-17): pay daily_rate ×
  // days (the admin-entered day count on the manual/add paths), WHT 3%, no SSO.
  // Short-circuits the hourly/salary engine entirely — same rule as the full
  // compute's helper branch, so all entry points agree. Admin-entered money extras
  // (service charge / additions / deductions) are preserved and folded into gross,
  // matching the normal path's WHT-on-gross treatment. rate must be > 0 (0/blank =
  // not a helper) so a mistaken 0 never zeroes a real employee's pay.
  if (hMode === "daily") {
    const h = computeHelperLine({ employee: e, clockInDays: daysWorked, settings });
    if (serviceCharge === 0 && otherAdditions === 0 && otherDeductions === 0) return h;
    const gross = round2(h.base_pay + serviceCharge + otherAdditions);
    const tax = gross > 0 ? computeWht(gross, settings) : 0;
    const net = round2(gross - tax - otherDeductions);
    return {
      ...h,
      service_charge: round2(serviceCharge),
      other_additions: round2(otherAdditions),
      other_deductions: round2(otherDeductions),
      gross_pay: gross,
      tax_amount: round2(tax),
      net_pay: net
    };
  }

  // Period-relative FT cycle (transition month = weekly) — owner 2026-07-16.
  const ftCycle = ftEffectiveCycle(e.ft_started_at, e.pay_cycle, periodStart.slice(0, 7));

  const ptRate = e.hourly_rate ?? settings.pt_default_hourly_rate;
  const ftHourlyEquivalent = e.monthly_salary ? e.monthly_salary / 30 / 8 : 0;
  const effectiveHourlyRate =
    e.employment_type === "pt" ? ptRate :
    e.employment_type === "ft" ? ftHourlyEquivalent : 0;

  // Split holiday_minutes proportionally across regular + OT
  const totalMin = regularMinutes + otMinutes;
  const regHolidayMin = totalMin > 0
    ? Math.min(regularMinutes, Math.round(holidayMinutes * regularMinutes / totalMin))
    : 0;
  const otHolidayMin = Math.max(0, Math.min(otMinutes, holidayMinutes - regHolidayMin));
  const regNormalMin = regularMinutes - regHolidayMin;
  const otNormalMin = otMinutes - otHolidayMin;

  // Base pay
  let basePay = 0;
  if (e.employment_type === "pt") {
    basePay = (regNormalMin / 60) * ptRate
           + (regHolidayMin / 60) * ptRate * PT_HOLIDAY_MULTIPLIER;
  } else if (e.employment_type === "ft" && e.monthly_salary && e.is_primary_branch !== 0) {
    // FT salary only at the home/primary branch (owner 2026-07-14) — see the
    // shift-based path above. Non-primary branch gets no base here either.
    if (cycle === "monthly" && ftCycle === "monthly") {
      basePay = e.monthly_salary;
      // Hire/resignation month → daily rate salary/30 × days entered (owner
      // 2026-08-03; manual path uses the admin's days count).
      if (isFtPartialMonth(e.hire_date, e.last_working_day, periodStart, periodEnd)) {
        basePay = Math.min(e.monthly_salary, round2((e.monthly_salary / 30) * daysWorked));
      }
    } else if (cycle === "weekly" && ftCycle === "weekly") {
      // Transition weekly (owner 2026-08-03): daily rate salary/30 × days entered
      // this round (replaces the salary/#Mondays split + next-month deferral).
      basePay = round2((e.monthly_salary / 30) * daysWorked);
    }
  }

  // ลาไม่รับค่าจ้าง — reduce FT base by salary/30 per unpaid day BEFORE gross
  // so SSO/tax fall on the actually-earned amount. Default 0 → no effect.
  const ulDeduction = unpaidLeaveDeduction(e, unpaidLeaveDays, basePay);
  basePay = round2(basePay - ulDeduction);

  // OT pay — PT gets holiday premium, FT does not (per company rule)
  let otPay = 0;
  if (e.employment_type === "pt") {
    otPay = computeOtPay(otNormalMin, ptRate, settings, 1)
          + computeOtPay(otHolidayMin, ptRate, settings, PT_HOLIDAY_MULTIPLIER);
  } else if (e.employment_type === "ft" && e.track_attendance !== 0) {
    // Salaried execs (track_attendance=0) get no OT (owner 2026-07-12).
    otPay = computeOtPay(otMinutes, ftHourlyEquivalent, settings, 1);
  }

  // DF: zero the shift pay so a manual edit never re-pays ค่าเวร to a DF doctor
  // (serviceCharge was already zeroed above; the fee rides in other_additions).
  if (dfActiveM) { basePay = 0; otPay = 0; }
  // DF is post-tax (no withholding for now) — exclude other_additions from the
  // tax base for a DF doctor; for everyone else it stays in gross as before.
  const taxableGross = dfActiveM ? (basePay + otPay + serviceCharge) : (basePay + otPay + serviceCharge + otherAdditions);
  const grossPay = basePay + otPay + serviceCharge + otherAdditions;

  // Tax mode BY GROUP (owner 2026-08-03, refined 2026-09-02):
  //   - พาร์ทไทม์ → หัก ณ ที่จ่าย 3% (WHT) เสมอ
  //   - ประจำ เดือนเปลี่ยนผ่าน (weekly cycle) / เดือนแรกที่เพิ่งเข้า → WHT
  //     (ยังไม่ทันขึ้นทะเบียนประกันสังคม)
  //   - ประจำ เต็มเดือน → ยึด salary_tax_mode รายคน (owner 2026-09-02: บางคน
  //     อยู่นอกระบบต้อง WHT — ไม่ใช่พนักงานประจำทุกคนเข้าประกันสังคม). ระบบเดิม
  //     บังคับ SSO ทุกคน ทำให้คนนอกระบบถูกหักประกันสังคมผิด.
  //   - อื่นๆ (df) → ยึด salary_tax_mode รายคน
  const ftStartForTax = e.ft_started_at ?? e.hire_date;
  const isFtFirstMonth = !!ftStartForTax && ftStartForTax >= periodStart && ftStartForTax <= periodEnd;
  const taxMode =
    e.employment_type === "pt" ? "wht"
    : e.employment_type === "ft"
      ? ((ftCycle === "weekly" || isFtFirstMonth) ? "wht" : (e.salary_tax_mode ?? "sso"))
      : (e.salary_tax_mode ?? "sso");
  let ssoAmount = 0;
  let taxAmount = 0;
  if (taxableGross > 0) {
    if (taxMode === "wht") {
      taxAmount = computeWht(taxableGross, settings);
    } else if (e.is_home_company !== 0) {
      ssoAmount = computeSso(basePay, cycle, settings); // SSO on base salary only
    }
    // else: cross-company helper — no SSO at a company that isn't their สังกัด.
  }

  const netPay = grossPay - ssoAmount - taxAmount - otherDeductions;
  // Suppress unused-var warning for effectiveHourlyRate (kept for future use)
  void effectiveHourlyRate;

  return {
    user_id: e.user_id,
    employee_code: e.employee_code,
    display_name: e.display_name,
    employment_type: e.employment_type,
    pay_cycle_snapshot: e.pay_cycle,
    hourly_rate_snapshot: e.hourly_rate,
    monthly_salary_snapshot: e.monthly_salary,
    salary_tax_mode_snapshot: taxMode,
    shift_minutes: regularMinutes + otMinutes,
    break_deducted_minutes: 0,                 // unknown in manual mode
    regular_minutes: regularMinutes,
    ot_minutes: otMinutes,
    holiday_minutes: holidayMinutes,
    days_worked: daysWorked,
    leave_days: leaveDays,
    unpaid_leave_days: unpaidLeaveDays,
    unpaid_leave_deduction: round2(ulDeduction),
    unpaired_clockins: unpaired,
    base_pay: round2(basePay),
    ot_pay: round2(otPay),
    service_charge: round2(serviceCharge),
    other_additions: round2(otherAdditions),
    gross_pay: round2(grossPay),
    sso_amount: round2(ssoAmount),
    tax_amount: round2(taxAmount),
    other_deductions: round2(otherDeductions),
    net_pay: round2(netPay)
  };
}

// ── DB orchestration ────────────────────────────────────────────────

/**
 * Compute (or recompute) all lines for a given draft period.
 * Wipes existing lines for the period first. Only allowed if status='draft'.
 */
export function computePayrollPeriod(db: Database.Database, periodId: number): {
  computed: number;
  skipped: number;
  locked: number;
} {
  const period = db.prepare(`
    SELECT id, cycle, target, data_source, period_start, period_end, pay_date, status, branch_id
    FROM payroll_periods WHERE id = ?
  `).get(periodId) as {
    id: number; cycle: "weekly" | "monthly";
    target: "pt" | "ft" | "all";
    data_source: "auto" | "manual";
    period_start: string; period_end: string; pay_date: string; status: string;
    branch_id: number | null;
  } | undefined;
  if (!period) throw new Error("period_not_found");
  if (period.status !== "draft") throw new Error("period_not_draft");

  const settings = db.prepare(`
    SELECT ot_mode, ot_flat_per_15min,
           break_threshold_minutes, break_deduction_minutes,
           long_shift_threshold_minutes, long_shift_break_minutes,
           sso_rate, sso_cap, pt_default_hourly_rate, wht_rate
    FROM payroll_settings WHERE id = 1
  `).get() as PayrollSettings;

  const fromIso = new Date(`${period.period_start}T00:00:00+07:00`).toISOString();
  const toIso = new Date(`${period.period_end}T23:59:59+07:00`).toISOString();

  // Public holidays in period — for PT premium 1.5x
  // PT 1.5× premium applies ONLY on designated "วันพิเศษ" (pt_special=1),
  // NOT on every public holiday (owner 2026-06-03). Public holidays are
  // now informational only.
  const holidays = db.prepare(`
    SELECT date FROM public_holidays
    WHERE date >= ? AND date <= ? AND pt_special = 1
  `).all(period.period_start, period.period_end) as Array<{ date: string }>;
  const holidaySet = new Set(holidays.map((h) => h.date));
  // วันจ่ายสองเท่า in period (owner 2026-07-21) — 2× base + OT for EVERYONE.
  const doubleSet = new Set(
    (db.prepare(`SELECT date FROM public_holidays WHERE date >= ? AND date <= ? AND double_pay = 1`)
      .all(period.period_start, period.period_end) as Array<{ date: string }>).map((h) => h.date)
  );
  // ทำงานวันหยุดประเพณี "ใช้สิทธิ์" (owner 2026-08-04) — 2× เฉพาะคนที่แอดมินเลือก
  // 'use' ในวันนั้น (แยกจาก double_pay ที่เป็นทั้งบริษัท). keyed user → set(dates).
  const useChoicesByUser = new Map<number, Set<string>>();
  for (const r of db.prepare(
    `SELECT user_id, work_date FROM holiday_work_choices
     WHERE choice = 'use' AND work_date >= ? AND work_date <= ?`
  ).all(period.period_start, period.period_end) as Array<{ user_id: number; work_date: string }>) {
    let s = useChoicesByUser.get(r.user_id);
    if (!s) { s = new Set(); useChoicesByUser.set(r.user_id, s); }
    s.add(r.work_date);
  }
  // Effective 2× set for one employee = global วันจ่ายสองเท่า ∪ their 'use' days.
  const doubleSetFor = (userId: number): Set<string> => {
    const own = useChoicesByUser.get(userId);
    return own && own.size ? new Set([...doubleSet, ...own]) : doubleSet;
  };

  // Scheduled shifts (work kind only) for PT grace clamping — keyed by
  // user → BKK assignment date → list of windows. Anchored at +07:00;
  // an end_time ≤ start_time means the shift crosses midnight, so the
  // end anchor rolls to the next calendar day.
  // Branch-scoped (owner 2026-07-31): a branch-stamped period only uses ITS
  // OWN branch's roster (plus any day reattributed into this branch). Before,
  // roster loaded across ALL branches, so a staffer rostered only at NAMA
  // showed a "footprint" in HYPO's period and leaked in at 0.00 (อนุธิดา).
  // Legacy NULL-branch periods keep the all-branches behaviour.
  const rosterBranchClause = period.branch_id != null
    ? `AND (ra.branch_id = @bid
            OR EXISTS (SELECT 1 FROM payroll_day_branch pdb
                       WHERE pdb.user_id = ra.user_id AND pdb.work_date = ra.assignment_date
                         AND pdb.branch_id = @bid))`
    : "";
  const rosterParams: Record<string, unknown> = { rstart: period.period_start, rend: period.period_end };
  if (period.branch_id != null) rosterParams.bid = period.branch_id;
  const rosterRows = db.prepare(`
    SELECT ra.user_id, ra.assignment_date,
           sc.start_time, sc.end_time, sc.break_start, sc.break_end
    FROM roster_assignments ra
    JOIN shift_codes sc ON sc.id = ra.shift_code_id
    WHERE ra.assignment_date >= @rstart AND ra.assignment_date <= @rend
      AND sc.kind = 'work'
      ${rosterBranchClause}
  `).all(rosterParams) as Array<{
    user_id: number; assignment_date: string;
    start_time: string; end_time: string;
    break_start: string | null; break_end: string | null;
  }>;
  const scheduledByUser = new Map<number, Map<string, ScheduledShift[]>>();
  for (const r of rosterRows) {
    // Degenerate / day-off-like rows (start == end) carry no real window.
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
    let byDate = scheduledByUser.get(r.user_id);
    if (!byDate) { byDate = new Map(); scheduledByUser.set(r.user_id, byDate); }
    const list = byDate.get(r.assignment_date) ?? [];
    list.push({ startTs, endTs, breakStartTs, breakEndTs });
    byDate.set(r.assignment_date, list);
  }

  // Shift-swap overlay — a confirmed swap replaces that day's scheduled
  // window with the friend's shift (owner 2026-06-08).
  const swapRows = db.prepare(`
    SELECT user_id, work_date, sched_in, sched_out FROM shift_swap_overrides
    WHERE work_date >= ? AND work_date <= ?
  `).all(period.period_start, period.period_end) as Array<{
    user_id: number; work_date: string; sched_in: string; sched_out: string;
  }>;
  for (const r of swapRows) {
    const sh = swapShiftWindow(r.work_date, r.sched_in, r.sched_out);
    if (!sh) continue;
    let byDate = scheduledByUser.get(r.user_id);
    if (!byDate) { byDate = new Map(); scheduledByUser.set(r.user_id, byDate); }
    byDate.set(r.work_date, [sh]);
  }

  // Eligible staff by cycle.
  //   weekly  → PT + FT-in-transition (owner 2026-07-12: a just-converted FT is
  //             paid weekly at fix-rate for their first month — pay_cycle='weekly')
  //   monthly → FT-monthly only
  // FT weekly-vs-monthly is PERIOD-RELATIVE via ft_started_at, not the live
  // pay_cycle flag (owner 2026-07-16): an FT's transition month (ft_started_at
  // month == this period's month) is weekly; later months monthly. So the same
  // employee lands in the same table whether the period is computed in real time
  // or backfilled. @pmonth = the period's "YYYY-MM". Legacy FT (ft_started_at
  // NULL) are always monthly.
  const periodMonth = period.period_start.slice(0, 7);
  // Cross-company/branch day-rate helpers (owner 2026-08-17): a person paid a
  // daily_rate at THIS branch belongs in its weekly round no matter their own
  // employment_type — so an FT from another company (พรนภา) who helps is pulled
  // in and paid rate × วันที่ลงเวลา. Only when the period is branch-stamped and the
  // rate is > 0 (a 0/blank rate = not a helper). "0" keeps NULL-branch periods
  // valid SQL (the guard below de-references it).
  // A helper is either: a positive daily_rate at this branch (any employment type),
  // OR an FT (paid elsewhere) with a per-branch hourly rate at a NON-home branch
  // (owner 2026-08-18 — paid by the hour like a PT). Real PTs are already selected
  // by the PT clause, so the hourly arm is FT-only.
  const helperExists = period.branch_id != null
    ? `EXISTS (SELECT 1 FROM user_branches ub WHERE ub.user_id = users.id AND ub.branch_id = @bid
                AND ((ub.daily_rate IS NOT NULL AND ub.daily_rate > 0)
                     OR (users.employment_type = 'ft' AND ub.is_primary = 0 AND ub.hourly_rate IS NOT NULL AND ub.hourly_rate > 0)))`
    : "0";
  const helperClause = period.branch_id != null ? " OR " + helperExists : "";
  let staffWhere: string;
  if (period.cycle === "weekly") {
    staffWhere = "(employment_type = 'pt' OR (employment_type = 'ft' AND ft_started_at IS NOT NULL AND substr(ft_started_at,1,7) = @pmonth)" + helperClause + ")";
  } else {
    staffWhere = "employment_type = 'ft' AND (ft_started_at IS NULL OR substr(ft_started_at,1,7) < @pmonth)";
  }
  // Branch scoping (owner 2026-06-10): a branch-stamped period only
  // includes employees assigned to that branch (user_branches). Legacy
  // periods (branch_id NULL) keep the old all-branches behaviour.
  // Auto-include (owner 2026-07-31): a staffer whose day was REATTRIBUTED into
  // this branch (payroll_day_branch) belongs in this period even when they are
  // not formally assigned here — the "helped ไฮโป that day" case. So the branch
  // gate is membership OR a reattribution into this branch within the window.
  const branchClause = period.branch_id != null
    ? `AND (EXISTS (SELECT 1 FROM user_branches ub WHERE ub.user_id = users.id AND ub.branch_id = @bid)
            OR EXISTS (SELECT 1 FROM payroll_day_branch pdb
                       WHERE pdb.user_id = users.id AND pdb.branch_id = @bid
                         AND pdb.work_date >= @pstart AND pdb.work_date <= @pend))`
    : "";
  // is_primary_branch — 1 when THIS period's branch is the employee's home
  // branch, so FT salary pays here only (owner 2026-07-14). Home = the
  // is_primary=1 membership, falling back to the lowest branch_id if none is
  // flagged (fail-safe: never drops an FT's salary). Legacy all-branches
  // periods (branch_id NULL) treat everyone as primary → unchanged behaviour.
  const primaryExpr = period.branch_id != null
    ? `CASE WHEN @bid = COALESCE(
           (SELECT ub.branch_id FROM user_branches ub WHERE ub.user_id = users.id AND ub.is_primary = 1 LIMIT 1),
           (SELECT MIN(ub.branch_id) FROM user_branches ub WHERE ub.user_id = users.id)
         ) THEN 1 ELSE 0 END AS is_primary_branch`
    : "1 AS is_primary_branch";
  // is_home_company — 1 unless we KNOW this period's branch is in a DIFFERENT
  // company than the employee's home/สังกัด (owner 2026-07-29). Only then (both
  // company_ids known AND differ) is it 0 → no ประกันสังคม withheld here (the
  // home employer already sends it). Home company = the company of the same
  // primary branch used above. Fail-safe: any NULL company_id → 1 (unchanged).
  const periodCompanyId = period.branch_id != null
    ? ((db.prepare("SELECT company_id AS c FROM branches WHERE id = ?").get(period.branch_id) as { c: number | null } | undefined)?.c ?? null)
    : null;
  const homeCompanyExpr = (period.branch_id != null && periodCompanyId != null)
    ? `CASE WHEN (SELECT b.company_id FROM branches b WHERE b.id = COALESCE(
             (SELECT ub.branch_id FROM user_branches ub WHERE ub.user_id = users.id AND ub.is_primary = 1 LIMIT 1),
             (SELECT MIN(ub.branch_id) FROM user_branches ub WHERE ub.user_id = users.id)
           )) IS @pcompany THEN 1
         WHEN (SELECT b.company_id FROM branches b WHERE b.id = COALESCE(
             (SELECT ub.branch_id FROM user_branches ub WHERE ub.user_id = users.id AND ub.is_primary = 1 LIMIT 1),
             (SELECT MIN(ub.branch_id) FROM user_branches ub WHERE ub.user_id = users.id)
           )) IS NULL THEN 1
         ELSE 0 END AS is_home_company`
    : "1 AS is_home_company";
  // A monthly period must NOT include an FT in their PT→FT transition month —
  // that first month is paid WEEKLY at fix-rate, so pulling them into the same
  // month's monthly round double-pays (owner 2026-07-18: นาย ธนะรัตน์). The boot
  // migration later flips pay_cycle→monthly, which would otherwise sweep them in
  // when this June round is recomputed in July. Keyed on ft_started_at's month.
  const ftTransitionExclude = period.cycle === "monthly"
    ? "AND NOT (employment_type = 'ft' AND ft_started_at IS NOT NULL AND substr(ft_started_at, 1, 7) = @pmonth)"
    : "";
  const staffSql = `
    SELECT id AS user_id, display_name, employment_type, employee_code,
           ${branchHourlyRateSelect(period.branch_id)}, monthly_salary, pay_cycle, salary_tax_mode, track_attendance,
           hire_date, ft_started_at, ft_salary_paid_through, pt_started_at, df_started_at,
           ${branchDailyRateSelect(period.branch_id)},
           ${branchOnlyHourlyRateSelect(period.branch_id)},
           ${LAST_WORKING_DAY_SELECT},
           ${primaryExpr},
           ${homeCompanyExpr}
    FROM users
    WHERE role IN ('staff', 'admin') AND employment_type IS NOT NULL
      AND is_test_account = 0
      -- Only currently-employed staff — never pay a disabled/resigned/terminated
      -- account (owner 2026-07-18: เลิกจ้างแล้วยังโผล่ในรอบ).
      AND status NOT IN ('disabled', 'resigned', 'terminated')
      -- Hired on/before the period ended — a future hire doesn't belong in a
      -- past round (owner 2026-07-18: เข้างาน 1 ก.ค. หลุดเข้ารอบ มิ.ย.).
      AND (hire_date IS NULL OR hire_date <= @pend)
      AND ${staffWhere}
      -- Hide a salary-less FT (unconfigured account) — but NEVER a day-rate helper
      -- (paid from daily_rate) NOR a Doctor-Fee doctor once their DF has started
      -- (paid from DF, not salary; owner 2026-08). A DF doctor is still hidden in
      -- periods BEFORE their df_started_at month (no phantom 0-baht historical line).
      AND NOT (employment_type = 'ft' AND COALESCE(monthly_salary, 0) = 0 AND NOT (${helperExists})
               AND (df_started_at IS NULL OR substr(df_started_at, 1, 7) > @pmonth))
      ${ftTransitionExclude}
      ${branchClause}
    ORDER BY CASE WHEN employment_type = 'ft' THEN 0 WHEN employment_type = 'pt' THEN 1 ELSE 2 END,
             display_name
  `;
  const staffParams: Record<string, unknown> = { pend: period.period_end, pmonth: periodMonth };
  if (period.branch_id != null) { staffParams.bid = period.branch_id; staffParams.pstart = period.period_start; }
  if (period.branch_id != null && periodCompanyId != null) staffParams.pcompany = periodCompanyId;
  const staffRaw = db.prepare(staffSql).all(staffParams) as Array<StaffRawRow>;
  const staff: EmployeePayrollSnapshot[] = staffRaw.map((r) => ({
    ...r,
    last_working_day: earliestDate(r.resign_last_day, r.term_last_day)
  }));

  // Time entries in range — scoped to the period's branch by EFFECTIVE branch
  // (owner 2026-07-31). We load every punch in the window and keep the ones
  // whose effective branch (per-day reattribution ?? punched branch) matches
  // this period's branch. This both DROPS a day moved out to another branch and
  // PULLS IN a day moved here from another branch, symmetrically.
  // EXCEPTION (owner 2026-06-15): a punch created by an APPROVED time
  // certification is always included even if its branch_id is NULL or differs
  // from the period — the admin already approved that time, so it must reach
  // payroll regardless of where the branch stamp landed (see keepEntryForBranch).
  const dayBranch = loadDayBranchMap(db, period.period_start, period.period_end);
  const certIds = new Set(
    (db.prepare(
      "SELECT entry_id FROM time_certifications WHERE status = 'approved' AND entry_id IS NOT NULL"
    ).all() as Array<{ entry_id: number }>).map((r) => r.entry_id)
  );
  const rawEntries = db.prepare(
    "SELECT id, user_id, ts, type, branch_id FROM time_entries WHERE ts >= ? AND ts <= ?"
  ).all(fromIso, toIso) as EntryWithBranch[];
  const entries: Entry[] = rawEntries
    .filter((e) => keepEntryForBranch(e, period.branch_id, dayBranch, certIds))
    .map((e) => ({ user_id: e.user_id, ts: e.ts, type: e.type }));
  const entriesByUser = new Map<number, Entry[]>();
  for (const e of entries) {
    if (!entriesByUser.has(e.user_id)) entriesByUser.set(e.user_id, []);
    entriesByUser.get(e.user_id)!.push(e);
  }

  // Per-day clock overrides (payroll_line_days) — admin corrections that
  // win over the time-clock for specific days. Grouped by user.
  const overrideRows = db.prepare(`
    SELECT user_id, work_date, clock_in, clock_out,
           sched_in, sched_out, break_min, worked_min, ot_min, ot_pay, ot_until
    FROM payroll_line_days WHERE period_id = ?
  `).all(periodId) as Array<{
    user_id: number; work_date: string; clock_in: string | null; clock_out: string | null;
    sched_in: string | null; sched_out: string | null;
    break_min: number | null; worked_min: number | null; ot_min: number | null;
    ot_pay: number | null; ot_until: string | null;
  }>;
  const overridesByUser = new Map<number, DayOverrideRow[]>();
  const fieldOverridesByUser = new Map<number, Map<string, DayFieldOverride>>();
  for (const r of overrideRows) {
    const list = overridesByUser.get(r.user_id) ?? [];
    list.push({
      work_date: r.work_date, clock_in: r.clock_in, clock_out: r.clock_out,
      sched_in: r.sched_in, sched_out: r.sched_out
    });
    overridesByUser.set(r.user_id, list);
    let fm = fieldOverridesByUser.get(r.user_id);
    if (!fm) { fm = new Map(); fieldOverridesByUser.set(r.user_id, fm); }
    fm.set(r.work_date, {
      sched_in: r.sched_in, sched_out: r.sched_out, break_min: r.break_min,
      worked_min: r.worked_min, ot_min: r.ot_min, ot_pay: r.ot_pay, ot_until: r.ot_until
    });
  }

  // Approved leave overlapping period (count days within period)
  const leaves = db.prepare(`
    SELECT user_id, date_from, date_to, days
    FROM leave_requests
    WHERE status = 'approved'
      AND NOT (date_to < ? OR date_from > ?)
  `).all(period.period_start, period.period_end) as Array<{
    user_id: number; date_from: string; date_to: string; days: number;
  }>;
  const leaveDaysByUser = new Map<number, number>();
  // Per-user set of approved-leave DATES in the period (Phase B no-show detection).
  const leaveDatesByUser = new Map<number, Set<string>>();
  for (const lv of leaves) {
    // Pro-rate days within the period if the leave spans outside
    const start = lv.date_from < period.period_start ? period.period_start : lv.date_from;
    const end = lv.date_to > period.period_end ? period.period_end : lv.date_to;
    let d = 0;
    let cur = start;
    let lvSet = leaveDatesByUser.get(lv.user_id);
    if (!lvSet) { lvSet = new Set<string>(); leaveDatesByUser.set(lv.user_id, lvSet); }
    while (cur <= end) {
      d++;
      lvSet.add(cur);
      const nd = new Date(`${cur}T00:00:00Z`);
      nd.setUTCDate(nd.getUTCDate() + 1);
      cur = nd.toISOString().slice(0, 10);
    }
    // If the leave was fractional (hourly), use the recorded days value scaled
    const totalRecorded = lv.days || 0;
    const inPeriodDays = totalRecorded === 0 ? d :
      // Simple pro-rate: leave's days * (days_in_period / total_span_days)
      (() => {
        const totalSpanDays = (() => {
          let t = 0; let c = lv.date_from;
          while (c <= lv.date_to) {
            t++;
            const nd = new Date(`${c}T00:00:00Z`);
            nd.setUTCDate(nd.getUTCDate() + 1);
            c = nd.toISOString().slice(0, 10);
          }
          return t || 1;
        })();
        return totalRecorded * (d / totalSpanDays);
      })();
    leaveDaysByUser.set(lv.user_id, (leaveDaysByUser.get(lv.user_id) || 0) + inPeriodDays);
  }

  // Approved OT requests in the period — keyed user → date → requested_until
  // (late end) + requested_from (early start; nullable). The two segments are
  // gated independently (owner 2026-08-04): late credited only when
  // status='approved', early only when early_status='approved'. A row is loaded
  // if EITHER segment is approved.
  const otRows = db.prepare(`
    SELECT user_id, work_date, requested_until, requested_from, status, early_status
    FROM ot_requests
    WHERE (status = 'approved' OR early_status = 'approved')
      AND work_date >= ? AND work_date <= ?
  `).all(period.period_start, period.period_end) as Array<{
    user_id: number; work_date: string; requested_until: string; requested_from: string | null;
    status: string; early_status: string | null;
  }>;
  const approvedOtByUser = new Map<number, Map<string, string>>();
  const approvedEarlyByUser = new Map<number, Map<string, string>>();
  for (const r of otRows) {
    if (r.status === "approved" && r.requested_until) {
      let m = approvedOtByUser.get(r.user_id);
      if (!m) { m = new Map(); approvedOtByUser.set(r.user_id, m); }
      m.set(r.work_date, r.requested_until);
    }
    if (r.early_status === "approved" && r.requested_from) {
      let e2 = approvedEarlyByUser.get(r.user_id);
      if (!e2) { e2 = new Map(); approvedEarlyByUser.set(r.user_id, e2); }
      e2.set(r.work_date, r.requested_from);
    }
  }

  // Reviewed lines are FROZEN (owner 2026-09-02: "ติ๊กตรวจแล้ว เวลาออกจากหน้านี้
  // ข้อมูลต้องไม่เปลี่ยน"). A line the admin has signed off ("ตรวจแล้ว") keeps its
  // stored numbers and its review through a full recompute — it survives the wipe
  // below and is skipped in the loop. To change a reviewed line, un-tick it first
  // (or edit it directly — recomputeLine clears the review when numbers change).
  const reviewedUserIds = new Set(
    (db.prepare(
      "SELECT user_id FROM payroll_lines WHERE period_id = ? AND reviewed_at IS NOT NULL"
    ).all(periodId) as Array<{ user_id: number }>).map((r) => r.user_id)
  );

  // Wipe existing (non-reviewed) lines and recompute
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM payroll_lines WHERE period_id = ? AND reviewed_at IS NULL").run(periodId);

    const insertLine = db.prepare(`
      INSERT INTO payroll_lines (
        period_id, user_id, employee_code, display_name, employment_type,
        pay_cycle_snapshot, hourly_rate_snapshot, monthly_salary_snapshot,
        salary_tax_mode_snapshot,
        shift_minutes, break_deducted_minutes, regular_minutes, ot_minutes,
        holiday_minutes,
        days_worked, leave_days, unpaired_clockins,
        base_pay, ot_pay, service_charge, other_additions, gross_pay,
        sso_amount, tax_amount, other_deductions, drink_deductions, mealpass_deductions, net_pay,
        is_helper
      ) VALUES (?,?,?,?,?, ?,?,?, ?, ?,?,?,?, ?, ?,?,?, ?,?,?,?,?, ?,?,?,?,?,?, ?)
    `);

    // Doctor Fee (DF) — owner 2026-08. For a clinic period, pre-compute each
    // doctor's fee for THIS period's date range (HSC revenue × roster share),
    // so a doctor on DF is paid it instead of ค่าเวร. Empty for non-clinic
    // branches. Keyed user_id → fee (บาท).
    const dfByUser = new Map<number, number>();
    const dfBranchPeriod = period.branch_id != null && isDfBranch(period.branch_id);
    if (dfBranchPeriod) {
      try {
        const dfRes = computeDoctorFees(period.branch_id!, period.period_start, period.period_end);
        for (const doc of dfRes.doctors) dfByUser.set(doc.user_id, doc.totalFee);
      } catch { /* DF is best-effort; never block a payroll run */ }
    }

    let computed = 0;
    let skipped = 0;
    let locked = 0;
    for (const emp of staff) {
      // Frozen: a reviewed line survived the wipe above — leave it untouched.
      if (reviewedUserIds.has(emp.user_id)) { locked++; continue; }
      // Cross-company/branch day-rate HELPER (owner 2026-08-17): a person with a
      // daily_rate set for THIS branch is paid a flat fee per day they clocked in
      // here (WHT 3% by the paying company, no SSO), instead of their own
      // hourly/salary. Handled before the normal path and short-circuited so the
      // salary/hourly engine never runs for them. No clock-in here → not this round.
      const mode = helperMode(emp);
      if (mode === "daily") {
        const hEntries = period.data_source === "manual" ? [] : entriesByUser.get(emp.user_id) ?? [];
        const hDays = countClockInDays(hEntries);
        if (hDays === 0) { skipped++; continue; }
        const hLine = computeHelperLine({ employee: emp, clockInDays: hDays, settings });
        const hDrink = sumRedeemedDrinksForUser(db, hLine.user_id, period.period_start, period.period_end, period.branch_id);
        const hMeal = sumCrossCompanyChargesForUser(hLine.user_id, period.period_start, period.period_end, period.branch_id, db);
        insertLine.run(
          periodId, hLine.user_id,
          hLine.employee_code, hLine.display_name, hLine.employment_type,
          hLine.pay_cycle_snapshot, hLine.hourly_rate_snapshot, hLine.monthly_salary_snapshot,
          hLine.salary_tax_mode_snapshot,
          hLine.shift_minutes, hLine.break_deducted_minutes, hLine.regular_minutes, hLine.ot_minutes,
          hLine.holiday_minutes,
          hLine.days_worked, hLine.leave_days, hLine.unpaired_clockins,
          hLine.base_pay, hLine.ot_pay, hLine.service_charge, hLine.other_additions, hLine.gross_pay,
          hLine.sso_amount, hLine.tax_amount, hLine.other_deductions, round2(hDrink),
          round2(hMeal),
          round2(Math.max(0, hLine.net_pay - hDrink - hMeal)),
          1
        );
        computed++;
        continue;
      }
      // Skip employees with NO footprint in this period (owner 2026-07-31:
      // อนุธิดา เพิ่งเข้าวันนี้ ไม่มีเวร ไม่มีลงเวลา แต่โผล่ 0.00). Hide a line
      // only when the person has NEITHER a roster NOR a clock-in in the
      // window. Guards so nobody who should be paid disappears:
      //  - monthly_salary > 0 → salaried, paid regardless of any activity
      //  - approved leave / per-day override (manual entry) / approved OT
      //    all count as a footprint too
      // If a skip is ever wrong, the admin "เพิ่มพนักงาน" button re-adds the
      // line (see the standalone INSERT below).
      const hasRoster = (scheduledByUser.get(emp.user_id)?.size ?? 0) > 0;
      const hasEntries = (entriesByUser.get(emp.user_id)?.length ?? 0) > 0;
      const hasOverride = (overridesByUser.get(emp.user_id)?.length ?? 0) > 0;
      const hasLeave = (leaveDaysByUser.get(emp.user_id) ?? 0) > 0;
      const hasOt = (approvedOtByUser.get(emp.user_id)?.size ?? 0) > 0;
      // An hourly helper is paid by the hour here, NOT salaried — so a no-footprint
      // hourly helper is skipped just like a PT (owner 2026-08-18), not kept as a
      // 0-baht salaried line.
      const isSalaried = (emp.monthly_salary ?? 0) > 0 && mode !== "hourly";
      // A DF doctor with a fee this period is a footprint too — keep their line.
      const hasDf = (dfByUser.get(emp.user_id) ?? 0) > 0;
      if (!isSalaried && !hasRoster && !hasEntries && !hasOverride && !hasLeave && !hasOt && !hasDf) {
        skipped++;
        continue;
      }

      // In manual mode, do NOT pull time_entries / leaves — the admin
      // enters each day's clock-in/out, which lands as a per-day override.
      const userEntries = period.data_source === "manual"
        ? []
        : entriesByUser.get(emp.user_id) ?? [];
      const auto = pairShifts(userEntries);
      // Merge admin per-day overrides over the auto shifts (override
      // date wins). In manual mode auto is empty, so shifts come purely
      // from overrides.
      const overrideMap = overridesToShiftMap(overridesByUser.get(emp.user_id) ?? []);
      const shifts = mergeDayOverrides(auto.shifts, overrideMap);
      const unpaired = auto.unpaired;
      const leaveDays = period.data_source === "manual"
        ? 0
        : leaveDaysByUser.get(emp.user_id) ?? 0;

      // Hourly helper (owner 2026-08-18): compute via the PT engine (OT + วันพิเศษ
      // ×1.5, WHT 3%, no SSO all fall out of PT semantics) on a cast snapshot, then
      // flag the line so the UI shows it as a helper.
      const empForCompute = mode === "hourly" ? asHourlyHelper(emp) : emp;
      const line = computeLineForEmployee({
        employee: empForCompute,
        shifts,
        unpaired,
        leaveDays,
        cycle: period.cycle,
        periodStart: period.period_start,
        periodEnd: period.period_end,
        payDate: period.pay_date,
        settings,
        holidaySet,
        doubleSet: doubleSetFor(emp.user_id),
        // Grace + scheduled-break apply in both modes when a roster
        // exists (the rule is independent of where the time came from).
        scheduledByDate: scheduledByUser.get(emp.user_id),
        approvedOtByDate: approvedOtByUser.get(emp.user_id),
        approvedEarlyByDate: approvedEarlyByUser.get(emp.user_id),
        fieldOverridesByDate: fieldOverridesByUser.get(emp.user_id),
        leaveDates: leaveDatesByUser.get(emp.user_id),
        dfAmount: dfByUser.get(emp.user_id) ?? 0,
        dfBranchPeriod
      });
      // Flag the helper line but store the person's REAL employment_type (the PT
      // cast was only to borrow the hourly math), so every write path agrees and
      // non-UI consumers still see the true type — same as the day-rate helper.
      if (mode === "hourly") { line.is_helper = HELPER_HOURLY; line.employment_type = emp.employment_type; }

      // Staff drink-welfare purchases (จ้อจี้) redeemed in this period at this
      // branch → a separate deduction, net_pay stored after it (owner 2026-07-30).
      const drinkDed = sumRedeemedDrinksForUser(
        db, line.user_id, period.period_start, period.period_end, period.branch_id
      );
      // Cross-company MEALPASS (ศาลาชิลล์) charges — deducted once, in the
      // buyer's home-branch round, by order date (owner 2026-08-10).
      const mealpassDed = sumCrossCompanyChargesForUser(
        line.user_id, period.period_start, period.period_end, period.branch_id, db
      );
      insertLine.run(
        periodId, line.user_id,
        line.employee_code, line.display_name, line.employment_type,
        line.pay_cycle_snapshot, line.hourly_rate_snapshot, line.monthly_salary_snapshot,
        line.salary_tax_mode_snapshot,
        line.shift_minutes, line.break_deducted_minutes, line.regular_minutes, line.ot_minutes,
        line.holiday_minutes,
        line.days_worked, line.leave_days, line.unpaired_clockins,
        line.base_pay, line.ot_pay, line.service_charge, line.other_additions, line.gross_pay,
        line.sso_amount, line.tax_amount, line.other_deductions, round2(drinkDed),
        round2(mealpassDed),
        // Safety floor (owner 2026-08-11): welfare deductions must never push net
        // pay below 0. The weekly ศาลาชิลล์ cap is the primary guard; this backstops it.
        round2(Math.max(0, line.net_pay - drinkDed - mealpassDed)),
        line.is_helper ?? 0
      );
      computed++;
    }

    // Update period metadata
    db.prepare(`
      UPDATE payroll_periods
      SET ot_mode_snapshot = ?,
          ot_flat_per_15min_snapshot = ?,
          computed_at = ?
      WHERE id = ?
    `).run(
      settings.ot_mode, settings.ot_flat_per_15min,
      new Date().toISOString(), periodId
    );

    return { computed, skipped, locked };
  });

  return tx();
}

/**
 * Recompute ONE employee's line from clock sources (time_entries +
 * payroll_line_days overrides + roster), preserving the admin-entered
 * money extras (service_charge / other_additions / other_deductions)
 * and leave_days already on the line. Used after a per-day clock edit
 * so the totals refresh without recomputing the whole period.
 *
 * Only valid while the period is 'draft'. Throws otherwise.
 */
export function recomputeLine(
  db: Database.Database, periodId: number, userId: number
): void {
  const period = db.prepare(`
    SELECT id, cycle, data_source, period_start, period_end, pay_date, status, branch_id
    FROM payroll_periods WHERE id = ?
  `).get(periodId) as {
    id: number; cycle: "weekly" | "monthly";
    data_source: "auto" | "manual";
    period_start: string; period_end: string; pay_date: string; status: string;
    branch_id: number | null;
  } | undefined;
  if (!period) throw new Error("period_not_found");
  if (period.status !== "draft") throw new Error("period_not_draft");

  let existing = db.prepare(`
    SELECT employee_code, display_name, employment_type,
           pay_cycle_snapshot, hourly_rate_snapshot, monthly_salary_snapshot,
           salary_tax_mode_snapshot,
           service_charge, other_additions, other_deductions, leave_days
    FROM payroll_lines WHERE period_id = ? AND user_id = ?
  `).get(periodId, userId) as {
    employee_code: string | null; display_name: string;
    employment_type: "pt" | "ft" | null;
    pay_cycle_snapshot: "weekly" | "monthly" | null;
    hourly_rate_snapshot: number | null; monthly_salary_snapshot: number | null;
    salary_tax_mode_snapshot: "sso" | "wht" | null;
    service_charge: number; other_additions: number; other_deductions: number;
    leave_days: number;
  } | undefined;
  // When the line is missing we INSERT a fresh one instead of throwing
  // (owner 2026-06-14). This is the case where the employee had no punches
  // when the period was first computed, then a time-certification added one
  // later — the per-user recompute fired on cert-approve must be able to
  // create the line, otherwise the certified hours never reach payroll.
  const lineExists = !!existing;
  if (!existing) {
    const u = db.prepare(`
      SELECT display_name, employee_code, employment_type,
             ${branchHourlyRateSelect(period.branch_id)}, monthly_salary, pay_cycle, salary_tax_mode
      FROM users
      WHERE id = ? AND role IN ('staff', 'admin') AND employment_type IS NOT NULL
        AND is_test_account = 0
        AND status NOT IN ('disabled', 'resigned', 'terminated')
    `).get(userId) as {
      display_name: string; employee_code: string | null;
      employment_type: "pt" | "ft" | null; hourly_rate: number | null;
      monthly_salary: number | null; pay_cycle: "weekly" | "monthly" | null;
      salary_tax_mode: "sso" | "wht" | null;
    } | undefined;
    // Not a payroll employee → nothing to create (caller skips on throw).
    if (!u) throw new Error("line_not_found");
    // Respect the period's branch scope so we don't pull in an out-of-branch
    // employee that the full compute would have excluded — EXCEPT one whose day
    // was reattributed into this branch (owner 2026-07-31: auto-include the
    // "helped ไฮโป that day" staffer even if not formally assigned here).
    if (period.branch_id != null) {
      const inBranch = db.prepare(
        "SELECT 1 FROM user_branches WHERE user_id = ? AND branch_id = ?"
      ).get(userId, period.branch_id);
      const reattributedIn = db.prepare(
        `SELECT 1 FROM payroll_day_branch
         WHERE user_id = ? AND branch_id = ? AND work_date >= ? AND work_date <= ?`
      ).get(userId, period.branch_id, period.period_start, period.period_end);
      if (!inBranch && !reattributedIn) throw new Error("line_not_found");
    }
    existing = {
      employee_code: u.employee_code, display_name: u.display_name,
      employment_type: u.employment_type, pay_cycle_snapshot: u.pay_cycle,
      hourly_rate_snapshot: u.hourly_rate, monthly_salary_snapshot: u.monthly_salary,
      salary_tax_mode_snapshot: u.salary_tax_mode,
      service_charge: 0, other_additions: 0, other_deductions: 0, leave_days: 0
    };
  }

  const fresh = db.prepare(`
    SELECT employment_type, ${branchHourlyRateSelect(period.branch_id)}, monthly_salary, pay_cycle, salary_tax_mode, track_attendance,
           hire_date, ft_started_at, ft_salary_paid_through, pt_started_at, df_started_at,
           ${branchDailyRateSelect(period.branch_id)},
           ${branchOnlyHourlyRateSelect(period.branch_id)},
           ${LAST_WORKING_DAY_SELECT}
    FROM users WHERE id = ?
  `).get(userId) as {
    employment_type: "pt" | "ft" | null; hourly_rate: number | null;
    monthly_salary: number | null; pay_cycle: "weekly" | "monthly" | null;
    salary_tax_mode: "sso" | "wht" | null; track_attendance: number | null;
    hire_date: string | null; ft_started_at: string | null; ft_salary_paid_through: string | null;
    pt_started_at: string | null; df_started_at: string | null;
    daily_rate: number | null; branch_hourly_rate: number | null;
    resign_last_day: string | null; term_last_day: string | null;
  } | undefined;

  const settings = db.prepare(`
    SELECT ot_mode, ot_flat_per_15min,
           break_threshold_minutes, break_deduction_minutes,
           long_shift_threshold_minutes, long_shift_break_minutes,
           sso_rate, sso_cap, pt_default_hourly_rate, wht_rate
    FROM payroll_settings WHERE id = 1
  `).get() as PayrollSettings;

  const fromIso = new Date(`${period.period_start}T00:00:00+07:00`).toISOString();
  const toIso = new Date(`${period.period_end}T23:59:59+07:00`).toISOString();

  // PT 1.5× premium = designated วันพิเศษ only (pt_special=1).
  const holidays = db.prepare(`
    SELECT date FROM public_holidays
    WHERE date >= ? AND date <= ? AND pt_special = 1
  `).all(period.period_start, period.period_end) as Array<{ date: string }>;
  const holidaySet = new Set(holidays.map((h) => h.date));
  // วันจ่ายสองเท่า in period (owner 2026-07-21) — 2× base + OT for EVERYONE,
  // plus this user's "ใช้สิทธิ์" holiday-work days (owner 2026-08-04) → 2× for
  // them only. Matches computePayrollPeriod's doubleSetFor(userId).
  const doubleSet = new Set(
    (db.prepare(`SELECT date FROM public_holidays WHERE date >= ? AND date <= ? AND double_pay = 1`)
      .all(period.period_start, period.period_end) as Array<{ date: string }>).map((h) => h.date)
  );
  for (const r of db.prepare(
    `SELECT work_date FROM holiday_work_choices
     WHERE user_id = ? AND choice = 'use' AND work_date >= ? AND work_date <= ?`
  ).all(userId, period.period_start, period.period_end) as Array<{ work_date: string }>) {
    doubleSet.add(r.work_date);
  }

  // Roster (work shifts) for this user → scheduled windows + break.
  // Branch-scoped to match computePayrollPeriod (owner 2026-07-31): a branch
  // period uses only its own branch's roster (plus days reattributed in), so a
  // NAMA-only roster never counts as a HYPO footprint. Legacy NULL-branch
  // periods stay all-branches.
  const rlBranchClause = period.branch_id != null
    ? `AND (ra.branch_id = @bid
            OR EXISTS (SELECT 1 FROM payroll_day_branch pdb
                       WHERE pdb.user_id = ra.user_id AND pdb.work_date = ra.assignment_date
                         AND pdb.branch_id = @bid))`
    : "";
  const rlParams: Record<string, unknown> = { uid: userId, rstart: period.period_start, rend: period.period_end };
  if (period.branch_id != null) rlParams.bid = period.branch_id;
  const rosterRows = db.prepare(`
    SELECT ra.assignment_date, sc.start_time, sc.end_time, sc.break_start, sc.break_end
    FROM roster_assignments ra
    JOIN shift_codes sc ON sc.id = ra.shift_code_id
    WHERE ra.user_id = @uid AND ra.assignment_date >= @rstart AND ra.assignment_date <= @rend
      AND sc.kind = 'work'
      ${rlBranchClause}
  `).all(rlParams) as Array<{
    assignment_date: string; start_time: string; end_time: string;
    break_start: string | null; break_end: string | null;
  }>;
  const scheduledByDate = new Map<string, ScheduledShift[]>();
  for (const r of rosterRows) {
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
    const list = scheduledByDate.get(r.assignment_date) ?? [];
    list.push({ startTs, endTs, breakStartTs, breakEndTs });
    scheduledByDate.set(r.assignment_date, list);
  }
  // Shift-swap overlay (owner 2026-06-08).
  overlaySwapShifts(db, userId, period.period_start, period.period_end, scheduledByDate);

  // Approved-leave DATES in the period (Phase B no-show detection) — the initial
  // compute has this per-user; the recompute path must re-query it here.
  const leaveDates = new Set<string>();
  for (const lv of db.prepare(`
    SELECT date_from, date_to FROM leave_requests
    WHERE user_id = ? AND status = 'approved' AND NOT (date_to < ? OR date_from > ?)
  `).all(userId, period.period_start, period.period_end) as Array<{ date_from: string; date_to: string }>) {
    let cur = lv.date_from < period.period_start ? period.period_start : lv.date_from;
    const end = lv.date_to > period.period_end ? period.period_end : lv.date_to;
    while (cur <= end) {
      leaveDates.add(cur);
      const nd = new Date(`${cur}T00:00:00Z`); nd.setUTCDate(nd.getUTCDate() + 1);
      cur = nd.toISOString().slice(0, 10);
    }
  }

  // Scope to the period's branch by EFFECTIVE branch (owner 2026-07-31): load
  // all of this user's punches in the window, keep those whose effective branch
  // (per-day reattribution ?? punched branch) matches this period — so a day
  // moved out drops here and a day moved in is pulled in (see keepEntryForBranch).
  let userEntries: Entry[] = [];
  if (period.data_source !== "manual") {
    const dayBranch = loadDayBranchMap(db, period.period_start, period.period_end);
    const certIds = new Set(
      (db.prepare(
        "SELECT entry_id FROM time_certifications WHERE status = 'approved' AND entry_id IS NOT NULL"
      ).all() as Array<{ entry_id: number }>).map((r) => r.entry_id)
    );
    const rawUserEntries = db.prepare(
      "SELECT id, user_id, ts, type, branch_id FROM time_entries WHERE user_id = ? AND ts >= ? AND ts <= ?"
    ).all(userId, fromIso, toIso) as EntryWithBranch[];
    userEntries = rawUserEntries
      .filter((e) => keepEntryForBranch(e, period.branch_id, dayBranch, certIds))
      .map((e) => ({ user_id: e.user_id, ts: e.ts, type: e.type }));
  }
  const auto = pairShifts(userEntries);
  const overrideRows = db.prepare(`
    SELECT work_date, clock_in, clock_out,
           sched_in, sched_out, break_min, worked_min, ot_min, ot_pay, ot_until
    FROM payroll_line_days WHERE period_id = ? AND user_id = ?
  `).all(periodId, userId) as Array<{
    work_date: string; clock_in: string | null; clock_out: string | null;
    sched_in: string | null; sched_out: string | null;
    break_min: number | null; worked_min: number | null; ot_min: number | null;
    ot_pay: number | null; ot_until: string | null;
  }>;
  const shifts = mergeDayOverrides(
    auto.shifts,
    overridesToShiftMap(overrideRows.map((r) => ({
      work_date: r.work_date, clock_in: r.clock_in, clock_out: r.clock_out,
      sched_in: r.sched_in, sched_out: r.sched_out
    })))
  );
  const fieldOverridesByDate = new Map<string, DayFieldOverride>();
  for (const r of overrideRows) {
    fieldOverridesByDate.set(r.work_date, {
      sched_in: r.sched_in, sched_out: r.sched_out, break_min: r.break_min,
      worked_min: r.worked_min, ot_min: r.ot_min, ot_pay: r.ot_pay, ot_until: r.ot_until
    });
  }

  // Approved OT for this user in the period (late end + early start). Each
  // segment is gated by its own status (owner 2026-08-04): late by `status`,
  // early by `early_status`.
  const otRows = db.prepare(`
    SELECT work_date, requested_until, requested_from, status, early_status
    FROM ot_requests
    WHERE user_id = ? AND (status = 'approved' OR early_status = 'approved')
      AND work_date >= ? AND work_date <= ?
  `).all(userId, period.period_start, period.period_end) as Array<{
    work_date: string; requested_until: string; requested_from: string | null;
    status: string; early_status: string | null;
  }>;
  const approvedOtByDate = new Map<string, string>();
  const approvedEarlyByDate = new Map<string, string>();
  for (const r of otRows) {
    if (r.status === "approved" && r.requested_until) approvedOtByDate.set(r.work_date, r.requested_until);
    if (r.early_status === "approved" && r.requested_from) approvedEarlyByDate.set(r.work_date, r.requested_from);
  }

  // Home-branch check for FT salary (owner 2026-07-14) — same rule as the full
  // compute: pay salary only when this period's branch is the employee's
  // primary (is_primary=1, else lowest branch_id). Legacy NULL-branch periods
  // treat everyone as primary.
  const primaryRow = db.prepare(`
    SELECT COALESCE(
      (SELECT branch_id FROM user_branches WHERE user_id = ? AND is_primary = 1 LIMIT 1),
      (SELECT MIN(branch_id) FROM user_branches WHERE user_id = ?)
    ) AS b
  `).get(userId, userId) as { b: number | null };
  const isPrimaryBranch = (period.branch_id == null || period.branch_id === primaryRow.b) ? 1 : 0;

  // Home-company check for ประกันสังคม (owner 2026-07-29) — SSO is withheld only
  // at the employee's own company (see resolveHomeCompanyFlag).
  const isHomeCompany = resolveHomeCompanyFlag(db, userId, period.branch_id);

  const employee: EmployeePayrollSnapshot = {
    user_id: userId,
    display_name: existing.display_name,
    employment_type: fresh?.employment_type ?? existing.employment_type,
    employee_code: existing.employee_code,
    hourly_rate: fresh?.hourly_rate ?? existing.hourly_rate_snapshot,
    monthly_salary: fresh?.monthly_salary ?? existing.monthly_salary_snapshot,
    pay_cycle: fresh?.pay_cycle ?? existing.pay_cycle_snapshot,
    salary_tax_mode: fresh?.salary_tax_mode ?? existing.salary_tax_mode_snapshot,
    track_attendance: fresh?.track_attendance ?? 1,
    is_primary_branch: isPrimaryBranch,
    is_home_company: isHomeCompany,
    hire_date: fresh?.hire_date ?? null,
    last_working_day: fresh ? earliestDate(fresh.resign_last_day, fresh.term_last_day) : null,
    ft_started_at: fresh?.ft_started_at ?? null,
    pt_started_at: fresh?.pt_started_at ?? null,
    df_started_at: fresh?.df_started_at ?? null,
    daily_rate: fresh?.daily_rate ?? null,
    branch_hourly_rate: fresh?.branch_hourly_rate ?? null,
    ft_salary_paid_through: fresh?.ft_salary_paid_through ?? null
  };

  const rlMode = helperMode(employee);

  // Cross-company/branch DAY-RATE helper (owner 2026-08-17): recompute as a flat
  // daily fee — days-with-a-clock-in × daily_rate, WHT 3% by the paying company,
  // no SSO — matching computePayrollPeriod's helper branch so every entry point
  // agrees. Short-circuits the hourly/salary engine (no OT, leave, or extras).
  if (rlMode === "daily") {
    const hDays = countClockInDays(userEntries);
    // No clock-in here → not a helper this round. Match computePayrollPeriod, which
    // skips a 0-day helper entirely: never INSERT a phantom 0-baht helper line.
    if (hDays === 0 && !lineExists) return;
    const hLine = computeHelperLine({ employee, clockInDays: hDays, settings });
    const hDrink = sumRedeemedDrinksForUser(db, userId, period.period_start, period.period_end, period.branch_id);
    const hMeal = sumCrossCompanyChargesForUser(userId, period.period_start, period.period_end, period.branch_id, db);
    const hNet = Math.max(0, hLine.net_pay - hDrink - hMeal);
    if (lineExists) {
      db.prepare(`
        UPDATE payroll_lines
        SET shift_minutes = 0, break_deducted_minutes = 0,
            regular_minutes = 0, ot_minutes = 0, holiday_minutes = 0,
            days_worked = ?, unpaired_clockins = 0,
            base_pay = ?, ot_pay = 0, gross_pay = ?,
            sso_amount = 0, tax_amount = ?, drink_deductions = ?, mealpass_deductions = ?, net_pay = ?,
            hourly_rate_snapshot = NULL, monthly_salary_snapshot = NULL,
            pay_cycle_snapshot = 'weekly', salary_tax_mode_snapshot = 'wht',
            is_helper = 1,
            overridden = 1, reviewed_at = NULL, reviewed_by = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE period_id = ? AND user_id = ?
      `).run(
        hLine.days_worked, round2(hLine.base_pay), round2(hLine.gross_pay),
        round2(hLine.tax_amount), round2(hDrink), round2(hMeal), round2(hNet),
        periodId, userId
      );
    } else {
      db.prepare(`
        INSERT INTO payroll_lines (
          period_id, user_id, employee_code, display_name, employment_type,
          pay_cycle_snapshot, hourly_rate_snapshot, monthly_salary_snapshot,
          salary_tax_mode_snapshot,
          shift_minutes, break_deducted_minutes, regular_minutes, ot_minutes,
          holiday_minutes, days_worked, leave_days, unpaired_clockins,
          base_pay, ot_pay, service_charge, other_additions, gross_pay,
          sso_amount, tax_amount, other_deductions, drink_deductions, mealpass_deductions, net_pay,
          is_helper
        ) VALUES (?,?,?,?,?, ?,?,?, ?, ?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?, ?)
      `).run(
        periodId, userId, existing.employee_code, existing.display_name, hLine.employment_type,
        'weekly', null, null,
        'wht',
        0, 0, 0, 0,
        0, hLine.days_worked, 0, 0,
        round2(hLine.base_pay), 0, 0, 0, round2(hLine.gross_pay),
        0, round2(hLine.tax_amount), 0, round2(hDrink), round2(hMeal), round2(hNet),
        1
      );
    }
    return;
  }

  // Hourly helper (owner 2026-08-18): compute via the PT engine on a cast snapshot
  // (OT + วันพิเศษ×1.5, WHT 3%, no SSO all fall out of PT semantics), then flag the
  // line. Normal lines use the employee snapshot unchanged.
  const rlEmp = rlMode === "hourly" ? asHourlyHelper(employee) : employee;
  // Doctor Fee (DF) — owner 2026-08. Recompute this doctor's fee for the period
  // range so a single-line recompute keeps DF instead of ค่าเวร.
  const rlDfBranch = period.branch_id != null && isDfBranch(period.branch_id);
  const dfActiveRL = rlDfBranch && employee.df_started_at != null && period.period_start.slice(0, 7) >= employee.df_started_at.slice(0, 7);
  let dfPayRL = 0;
  if (dfActiveRL) {
    try {
      const r = computeDoctorFees(period.branch_id!, period.period_start, period.period_end);
      dfPayRL = r.doctors.find((d) => d.user_id === userId)?.totalFee ?? 0;
    } catch { /* best-effort */ }
  }
  const computed = computeLineForEmployee({
    employee: rlEmp, shifts, unpaired: auto.unpaired,
    leaveDays: existing.leave_days,
    cycle: period.cycle, periodStart: period.period_start, periodEnd: period.period_end, payDate: period.pay_date,
    settings, holidaySet, doubleSet, scheduledByDate, approvedOtByDate, approvedEarlyByDate, fieldOverridesByDate, leaveDates,
    dfAmount: dfPayRL, dfBranchPeriod: rlDfBranch
  });
  // No worked time and no existing line → don't create a phantom 0-baht hourly-helper
  // line (matches computePayrollPeriod's skip).
  if (rlMode === "hourly" && !lineExists && computed.regular_minutes === 0 && computed.ot_minutes === 0) return;

  // Preserve admin money extras; recompute gross/SSO/tax/net to include them.
  // For a DF doctor, ค่าเวร is zero and the fee rides in other_additions (post-tax,
  // no withholding), replacing any admin-entered additions for that line.
  const svc = dfActiveRL ? 0 : existing.service_charge;
  const add = dfActiveRL ? round2(dfPayRL) : existing.other_additions;
  const ded = existing.other_deductions;
  const taxBase = dfActiveRL ? (computed.base_pay + computed.ot_pay + svc) : (computed.base_pay + computed.ot_pay + svc + add);
  const gross = computed.base_pay + computed.ot_pay + svc + add;
  const taxMode = rlEmp.salary_tax_mode ?? "sso";
  let sso = 0;
  let tax = 0;
  if (taxBase > 0) {
    if (taxMode === "wht") tax = computeWht(taxBase, settings);
    // Cross-company helper (is_home_company=0) → no SSO here; home employer sends it.
    else if (rlEmp.is_home_company !== 0) sso = computeSso(computed.base_pay, period.cycle, settings); // SSO on base salary only
  }
  const rlHelperFlag = rlMode === "hourly" ? HELPER_HOURLY : 0;
  // Staff drink-welfare (จ้อจี้) deductions redeemed in this period+branch —
  // a separate column, refreshed from the ledger on every recompute (owner
  // 2026-07-30). net stored after it.
  const drinkDed = sumRedeemedDrinksForUser(db, userId, period.period_start, period.period_end, period.branch_id);
  // Cross-company MEALPASS (ศาลาชิลล์) — deducted once, in the home-branch round,
  // by order date. Refreshed from the ledger on every recompute (owner 2026-08-10).
  const mealpassDed = sumCrossCompanyChargesForUser(userId, period.period_start, period.period_end, period.branch_id, db);
  // Safety floor (owner 2026-08-11): welfare deductions never push net below 0.
  const net = Math.max(0, gross - sso - tax - ded - drinkDed - mealpassDed);

  if (lineExists) {
    db.prepare(`
      UPDATE payroll_lines
      SET shift_minutes = ?, break_deducted_minutes = ?,
          regular_minutes = ?, ot_minutes = ?, holiday_minutes = ?,
          days_worked = ?, unpaired_clockins = ?,
          base_pay = ?, ot_pay = ?, service_charge = ?, other_additions = ?, gross_pay = ?,
          sso_amount = ?, tax_amount = ?, drink_deductions = ?, mealpass_deductions = ?, net_pay = ?,
          hourly_rate_snapshot = ?, monthly_salary_snapshot = ?,
          pay_cycle_snapshot = ?, salary_tax_mode_snapshot = ?,
          employment_type = ?, is_helper = ?,
          overridden = 1, reviewed_at = NULL, reviewed_by = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE period_id = ? AND user_id = ?
    `).run(
      computed.shift_minutes, computed.break_deducted_minutes,
      computed.regular_minutes, computed.ot_minutes, computed.holiday_minutes,
      computed.days_worked, computed.unpaired_clockins,
      round2(computed.base_pay), round2(computed.ot_pay), round2(svc), round2(add), round2(gross),
      round2(sso), round2(tax), round2(drinkDed), round2(mealpassDed), round2(net),
      rlEmp.hourly_rate, rlEmp.monthly_salary,
      rlEmp.pay_cycle, taxMode,
      // Store the REAL employment_type (an hourly helper is cast to PT only for the
      // math); is_helper carries the helper distinction. Keeps all paths consistent.
      employee.employment_type, rlHelperFlag,
      periodId, userId
    );
  } else {
    // Fresh line (employee had no punches at period-creation; a certification
    // added one later). Mirror computePayrollPeriod's insert column set; extras
    // are 0 for a brand-new line.
    db.prepare(`
      INSERT INTO payroll_lines (
        period_id, user_id, employee_code, display_name, employment_type,
        pay_cycle_snapshot, hourly_rate_snapshot, monthly_salary_snapshot,
        salary_tax_mode_snapshot,
        shift_minutes, break_deducted_minutes, regular_minutes, ot_minutes,
        holiday_minutes, days_worked, leave_days, unpaired_clockins,
        base_pay, ot_pay, service_charge, other_additions, gross_pay,
        sso_amount, tax_amount, other_deductions, drink_deductions, mealpass_deductions, net_pay,
        is_helper
      ) VALUES (?,?,?,?,?, ?,?,?, ?, ?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?, ?)
    `).run(
      periodId, userId, existing.employee_code, existing.display_name, employee.employment_type,
      rlEmp.pay_cycle, rlEmp.hourly_rate, rlEmp.monthly_salary,
      taxMode,
      computed.shift_minutes, computed.break_deducted_minutes, computed.regular_minutes, computed.ot_minutes,
      computed.holiday_minutes, computed.days_worked, existing.leave_days, computed.unpaired_clockins,
      round2(computed.base_pay), round2(computed.ot_pay), round2(svc), round2(add), round2(gross),
      round2(sso), round2(tax), round2(ded), round2(drinkDed), round2(mealpassDed), round2(net),
      rlHelperFlag
    );
  }
}
