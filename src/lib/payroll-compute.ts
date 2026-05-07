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
const PT_HOLIDAY_MULTIPLIER = 1.5;

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
}): ComputedLine {
  const { employee: e, shifts, unpaired, leaveDays, cycle, periodEnd, settings, holidaySet } = args;

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
    shiftMin += s.durationMinutes;
    const { workedMinutes, deducted } = deductBreak(s.durationMinutes, settings);
    breakDeducted += deducted;
    const split = splitRegularOt(workedMinutes);
    regularMin += split.regular;
    otMin += split.ot;

    const shiftDate = bkkDate(s.startTs);
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
  // 'sso' = ในระบบ → SSO 5% (cap) + PIT progressive
  // 'wht' = นอกระบบ → WHT 3% flat, no SSO, no PIT
  const taxMode = e.salary_tax_mode ?? "sso";
  let ssoAmount = 0;
  let taxAmount = 0;
  if (grossPay > 0) {
    if (taxMode === "wht") {
      taxAmount = computeWht(grossPay, settings);
    } else {
      ssoAmount = computeSso(grossPay, cycle, settings);
      taxAmount = computePeriodTax(grossPay, ssoAmount, cycle);
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
    SELECT id, cycle, target, period_start, period_end, status
    FROM payroll_periods WHERE id = ?
  `).get(periodId) as {
    id: number; cycle: "weekly" | "monthly";
    target: "pt" | "ft" | "all";
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
    WHERE role = 'staff' AND employment_type IS NOT NULL
      AND ${staffWhere}
    ORDER BY display_name
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
      const userEntries = entriesByUser.get(emp.user_id) ?? [];
      const { shifts, unpaired } = pairShifts(userEntries);
      const leaveDays = leaveDaysByUser.get(emp.user_id) ?? 0;

      const line = computeLineForEmployee({
        employee: emp,
        shifts,
        unpaired,
        leaveDays,
        cycle: period.cycle,
        periodEnd: period.period_end,
        settings,
        holidaySet
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
