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
//  SSO:   min(gross × rate, cap_for_period)  — cap pro-rated for weekly
//  Tax:   Thai PIT progressive — annualized
//
// All amounts in THB. Time in minutes. Dates in Bangkok local.

import type Database from "better-sqlite3";

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
};

// PT premium multiplier on public holidays (per company rule)
export const PT_HOLIDAY_MULTIPLIER = 1.5;

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

type Shift = { startTs: string; endTs: string; durationMinutes: number };

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
        const dur = (new Date(e.ts).getTime() - new Date(openIn).getTime()) / 60000;
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
  scheduled: ScheduledShift | null
): GracedShift {
  const inMs = new Date(shift.startTs).getTime();
  const outMs = new Date(shift.endTs).getTime();
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

  // Effective in: clamp to scheduled start unless late beyond grace
  let effIn: number;
  let lateMinutes = 0;
  if (inMs <= schStart + graceMs) {
    effIn = schStart;
  } else {
    effIn = inMs;
    lateMinutes = (inMs - schStart) / 60000;
  }

  // Effective out: clamp to scheduled end unless early beyond grace
  let effOut: number;
  let earlyMinutes = 0;
  if (outMs >= schEnd - graceMs) {
    effOut = schEnd;
  } else {
    effOut = outMs;
    earlyMinutes = (schEnd - outMs) / 60000;
  }

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
 */
export function computeSso(
  periodGross: number,
  cycle: "weekly" | "monthly",
  settings: PayrollSettings
): number {
  if (periodGross <= 0) return 0;
  const cap = cycle === "weekly" ? settings.sso_cap / 4 : settings.sso_cap;
  const raw = periodGross * settings.sso_rate;
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

export function computeLineForEmployee(args: {
  employee: EmployeePayrollSnapshot;
  shifts: Shift[];
  unpaired: number;
  leaveDays: number;
  cycle: "weekly" | "monthly";
  periodEnd: string;          // YYYY-MM-DD (used for FT-weekly division)
  settings: PayrollSettings;
  holidaySet: Set<string>;    // YYYY-MM-DD dates that count as PT premium days
  // PT grace: scheduled shift windows for this employee, keyed by the
  // BKK calendar date (YYYY-MM-DD) of the assignment. When provided and
  // the employee is part-time, each clocked shift is clamped to its
  // scheduled box ±5-min grace (see applyPtGrace). Omit / leave empty to
  // fall back to raw clock times (legacy behaviour, e.g. no roster).
  scheduledByDate?: Map<string, ScheduledShift[]>;
}): ComputedLine {
  const { employee: e, shifts, unpaired, leaveDays, cycle, periodEnd, settings, holidaySet, scheduledByDate } = args;

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

  for (const s of shifts) {
    const shiftDate = bkkDate(s.startTs);

    // PT: clamp the worked window to the scheduled shift box ±5-min
    // grace (no pay before start / after end; lateness & early-out
    // counted from actuals) AND deduct the scheduled break. FT keeps
    // the raw clock duration since its base pay is salary-driven.
    let grossMin = s.durationMinutes;   // before break (for shift_minutes col)
    let workedMinutes: number;
    let deducted: number;

    const sched = (e.employment_type === "pt" && scheduledByDate)
      ? pickScheduled(scheduledByDate.get(shiftDate) ?? [], s)
      : null;
    if (sched) {
      const g = applyPtGrace(s, sched);
      grossMin = g.grossMinutes;
      deducted = g.breakMinutes;
      workedMinutes = g.workedMinutes;
    } else {
      // No roster for this day (or FT) → legacy threshold-based break.
      const db = deductBreak(s.durationMinutes, settings);
      workedMinutes = db.workedMinutes;
      deducted = db.deducted;
    }

    shiftMin += grossMin;
    breakDeducted += deducted;
    const split = splitRegularOt(workedMinutes);
    regularMin += split.regular;
    otMin += split.ot;

    daysSet.add(shiftDate);
    const isHoliday = holidaySet.has(shiftDate);

    if (isHoliday) {
      holidayMin += workedMinutes;
    }

    // Per-shift pay computation
    if (e.employment_type === "pt") {
      // PT: holiday premium 1.5x on both base + OT
      const mult = isHoliday ? PT_HOLIDAY_MULTIPLIER : 1;
      ptBasePay += (split.regular / 60) * ptRate * mult;
      ptOtPay += computeOtPay(split.ot, ptRate, settings, mult);
    } else if (e.employment_type === "ft") {
      // FT: OT only (base is salary). No holiday premium per company rule.
      ftOtPay += computeOtPay(split.ot, ftHourlyEquivalent, settings, 1);
    }
  }

  // Base pay
  let basePay = 0;
  if (e.employment_type === "pt") {
    basePay = ptBasePay;
  } else if (e.employment_type === "ft") {
    // FT: salary regardless of clock — but only included in matching cycle
    if (e.pay_cycle === cycle && e.monthly_salary) {
      if (cycle === "monthly") {
        basePay = e.monthly_salary;
      } else {
        // weekly: divide salary by # of Mondays in the calendar month
        // containing periodEnd (= number of weekly pay-dates in that month)
        const mondays = countMondaysInMonth(periodEnd) || 4;
        basePay = e.monthly_salary / mondays;
      }
    }
    // Else: this employee has a different pay_cycle than this period — exclude
  }

  // Total OT pay
  const otPay = e.employment_type === "pt" ? ptOtPay : ftOtPay;

  // Service charge — Phase C4 (filled later)
  const serviceCharge = 0;
  const otherAdditions = 0;

  const grossPay = basePay + otPay + serviceCharge + otherAdditions;

  // Tax & SSO based on employee's salary_tax_mode
  // 'sso' = ในระบบ → SSO 5% (cap) only — PIT is not withheld monthly
  //                  (handled annually between employee & Revenue Dept)
  // 'wht' = นอกระบบ → WHT 3% flat on gross, no SSO
  const taxMode = e.salary_tax_mode ?? "sso";
  let ssoAmount = 0;
  let taxAmount = 0;
  if (grossPay > 0) {
    if (taxMode === "wht") {
      taxAmount = computeWht(grossPay, settings);
    } else {
      ssoAmount = computeSso(grossPay, cycle, settings);
    }
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
  daysWorked: number;
  unpaired: number;
  cycle: "weekly" | "monthly";
  periodEnd: string;
  settings: PayrollSettings;
  serviceCharge?: number;
  otherAdditions?: number;
  otherDeductions?: number;
}): ComputedLine {
  const {
    employee: e, regularMinutes, otMinutes, holidayMinutes, leaveDays,
    daysWorked, unpaired, cycle, periodEnd, settings,
    serviceCharge = 0, otherAdditions = 0, otherDeductions = 0
  } = args;

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
  } else if (e.employment_type === "ft" && e.monthly_salary) {
    if (cycle === "monthly" && e.pay_cycle === "monthly") {
      basePay = e.monthly_salary;
    } else if (cycle === "weekly" && e.pay_cycle === "weekly") {
      const mondays = countMondaysInMonth(periodEnd) || 4;
      basePay = e.monthly_salary / mondays;
    }
  }

  // OT pay — PT gets holiday premium, FT does not (per company rule)
  let otPay = 0;
  if (e.employment_type === "pt") {
    otPay = computeOtPay(otNormalMin, ptRate, settings, 1)
          + computeOtPay(otHolidayMin, ptRate, settings, PT_HOLIDAY_MULTIPLIER);
  } else if (e.employment_type === "ft") {
    otPay = computeOtPay(otMinutes, ftHourlyEquivalent, settings, 1);
  }

  const grossPay = basePay + otPay + serviceCharge + otherAdditions;

  const taxMode = e.salary_tax_mode ?? "sso";
  let ssoAmount = 0;
  let taxAmount = 0;
  if (grossPay > 0) {
    if (taxMode === "wht") {
      taxAmount = computeWht(grossPay, settings);
    } else {
      ssoAmount = computeSso(grossPay, cycle, settings);
    }
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
} {
  const period = db.prepare(`
    SELECT id, cycle, target, data_source, period_start, period_end, status
    FROM payroll_periods WHERE id = ?
  `).get(periodId) as {
    id: number; cycle: "weekly" | "monthly";
    target: "pt" | "ft" | "all";
    data_source: "auto" | "manual";
    period_start: string; period_end: string; status: string;
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
  const holidays = db.prepare(`
    SELECT date FROM public_holidays
    WHERE date >= ? AND date <= ?
  `).all(period.period_start, period.period_end) as Array<{ date: string }>;
  const holidaySet = new Set(holidays.map((h) => h.date));

  // Scheduled shifts (work kind only) for PT grace clamping — keyed by
  // user → BKK assignment date → list of windows. Anchored at +07:00;
  // an end_time ≤ start_time means the shift crosses midnight, so the
  // end anchor rolls to the next calendar day.
  const addDayYmd = (ymd: string): string => {
    const d = new Date(`${ymd}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  };
  const rosterRows = db.prepare(`
    SELECT ra.user_id, ra.assignment_date,
           sc.start_time, sc.end_time, sc.break_start, sc.break_end
    FROM roster_assignments ra
    JOIN shift_codes sc ON sc.id = ra.shift_code_id
    WHERE ra.assignment_date >= ? AND ra.assignment_date <= ?
      AND sc.kind = 'work'
  `).all(period.period_start, period.period_end) as Array<{
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

  // Eligible staff depend on (cycle, target):
  //   weekly + 'pt'  → PT only
  //   weekly + 'ft'  → FT-weekly only
  //   weekly + 'all' → PT + FT-weekly (legacy/backward compat)
  //   monthly + 'ft' → FT-monthly only
  //   monthly + 'all' → FT-monthly only (PT never on monthly cycle)
  let staffWhere: string;
  if (period.cycle === "weekly") {
    if (period.target === "pt") {
      staffWhere = "employment_type = 'pt'";
    } else if (period.target === "ft") {
      staffWhere = "employment_type = 'ft' AND pay_cycle = 'weekly'";
    } else {
      staffWhere = "(employment_type = 'pt' OR (employment_type = 'ft' AND pay_cycle = 'weekly'))";
    }
  } else {
    // monthly — only FT-monthly regardless of target
    staffWhere = "employment_type = 'ft' AND pay_cycle = 'monthly'";
  }
  const staffSql = `
    SELECT id AS user_id, display_name, employment_type, employee_code,
           hourly_rate, monthly_salary, pay_cycle, salary_tax_mode
    FROM users
    WHERE role IN ('staff', 'admin') AND employment_type IS NOT NULL
      AND is_test_account = 0
      AND ${staffWhere}
    ORDER BY CASE WHEN employment_type = 'ft' THEN 0 WHEN employment_type = 'pt' THEN 1 ELSE 2 END,
             display_name
  `;
  const staff = db.prepare(staffSql).all() as EmployeePayrollSnapshot[];

  // All time entries in range
  const entries = db.prepare(`
    SELECT user_id, ts, type FROM time_entries
    WHERE ts >= ? AND ts <= ?
  `).all(fromIso, toIso) as Entry[];
  const entriesByUser = new Map<number, Entry[]>();
  for (const e of entries) {
    if (!entriesByUser.has(e.user_id)) entriesByUser.set(e.user_id, []);
    entriesByUser.get(e.user_id)!.push(e);
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
  for (const lv of leaves) {
    // Pro-rate days within the period if the leave spans outside
    const start = lv.date_from < period.period_start ? period.period_start : lv.date_from;
    const end = lv.date_to > period.period_end ? period.period_end : lv.date_to;
    let d = 0;
    let cur = start;
    while (cur <= end) {
      d++;
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

  // Wipe existing lines and recompute
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM payroll_lines WHERE period_id = ?").run(periodId);

    const insertLine = db.prepare(`
      INSERT INTO payroll_lines (
        period_id, user_id, employee_code, display_name, employment_type,
        pay_cycle_snapshot, hourly_rate_snapshot, monthly_salary_snapshot,
        salary_tax_mode_snapshot,
        shift_minutes, break_deducted_minutes, regular_minutes, ot_minutes,
        holiday_minutes,
        days_worked, leave_days, unpaired_clockins,
        base_pay, ot_pay, service_charge, other_additions, gross_pay,
        sso_amount, tax_amount, other_deductions, net_pay
      ) VALUES (?,?,?,?,?, ?,?,?, ?, ?,?,?,?, ?, ?,?,?, ?,?,?,?,?, ?,?,?,?)
    `);

    let computed = 0;
    let skipped = 0;
    for (const emp of staff) {
      // In manual mode, do NOT pull time_entries / leaves — admin will fill in
      const userEntries = period.data_source === "manual"
        ? []
        : entriesByUser.get(emp.user_id) ?? [];
      const { shifts, unpaired } = pairShifts(userEntries);
      const leaveDays = period.data_source === "manual"
        ? 0
        : leaveDaysByUser.get(emp.user_id) ?? 0;

      const line = computeLineForEmployee({
        employee: emp,
        shifts,
        unpaired,
        leaveDays,
        cycle: period.cycle,
        periodEnd: period.period_end,
        settings,
        holidaySet,
        // PT grace only — in manual mode there are no shifts to clamp.
        scheduledByDate: period.data_source === "manual"
          ? undefined
          : scheduledByUser.get(emp.user_id)
      });

      insertLine.run(
        periodId, line.user_id,
        line.employee_code, line.display_name, line.employment_type,
        line.pay_cycle_snapshot, line.hourly_rate_snapshot, line.monthly_salary_snapshot,
        line.salary_tax_mode_snapshot,
        line.shift_minutes, line.break_deducted_minutes, line.regular_minutes, line.ot_minutes,
        line.holiday_minutes,
        line.days_worked, line.leave_days, line.unpaired_clockins,
        line.base_pay, line.ot_pay, line.service_charge, line.other_additions, line.gross_pay,
        line.sso_amount, line.tax_amount, line.other_deductions, line.net_pay
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

    return { computed, skipped };
  });

  return tx();
}
