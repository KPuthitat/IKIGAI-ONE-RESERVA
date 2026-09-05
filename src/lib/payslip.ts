// Shared payslip data (owner 2026-09-05). Both the admin payslip page and the
// new staff self-service payslip render the SAME document from this view, so an
// employee disputing their pay sees exactly what the admin sees — including the
// per-day time log and the "เพิ่มอื่นๆ" (double-pay premium) explanation.

import type Database from "better-sqlite3";
import { computeMonthlySvcSummary, type MonthlySvcSummary } from "@/lib/service-charge";
import { buildLineBreakdown, type BreakdownDay } from "@/lib/payroll-breakdown";

export type PayslipPeriod = {
  id: number;
  cycle: "weekly" | "monthly";
  target: "pt" | "ft" | "all";
  period_start: string;
  period_end: string;
  pay_date: string;
  status: "draft" | "finalized" | "paid" | "cancelled";
  branch_id: number | null;
};

export type PayslipLine = {
  user_id: number;
  employee_code: string | null;
  display_name: string;
  employment_type: "pt" | "ft" | null;
  pay_cycle_snapshot: "weekly" | "monthly" | null;
  hourly_rate_snapshot: number | null;
  monthly_salary_snapshot: number | null;
  salary_tax_mode_snapshot: "sso" | "wht" | null;
  shift_minutes: number;
  break_deducted_minutes: number;
  regular_minutes: number;
  ot_minutes: number;
  holiday_minutes: number;
  days_worked: number;
  leave_days: number;
  unpaid_leave_days: number;
  unpaired_clockins: number;
  base_pay: number;
  ot_pay: number;
  service_charge: number;
  other_additions: number;
  meeting_fee: number;
  gross_pay: number;
  sso_amount: number;
  drink_deductions: number;
  mealpass_deductions: number;
  tax_amount: number;
  other_deductions: number;
  net_pay: number;
};

export type PayslipProfile = {
  bank_name: string | null;
  bank_account: string | null;
  national_id: string | null;
  employee_code: string | null;
  title_prefix: string | null;
};

export type PayslipView = {
  period: PayslipPeriod;
  line: PayslipLine;
  profile: PayslipProfile | null;
  svcSummary: MonthlySvcSummary | null;
  svcRow: MonthlySvcSummary["rows"][number] | null;
  payslipBranchName: string | null;
  // Per-day time log (same computation as the admin modal) + the FT double-pay
  // premium total that rides in other_additions.
  dayLog: BreakdownDay[];
  doublePremium: number;
  ftMonthly: boolean;
};

const LINE_COLS = `
  user_id, employee_code, display_name, employment_type,
  pay_cycle_snapshot, hourly_rate_snapshot, monthly_salary_snapshot,
  salary_tax_mode_snapshot,
  shift_minutes, break_deducted_minutes, regular_minutes, ot_minutes,
  holiday_minutes,
  days_worked, leave_days, unpaid_leave_days, unpaired_clockins,
  base_pay, ot_pay, service_charge, other_additions, meeting_fee, gross_pay,
  sso_amount, tax_amount, other_deductions, drink_deductions, mealpass_deductions, net_pay
`;

/**
 * Assemble everything a payslip needs for (periodId, userId). Returns null when
 * the period or the employee's line doesn't exist. Read-only.
 */
export function buildPayslipView(
  db: Database.Database, periodId: number, userId: number
): PayslipView | null {
  const period = db.prepare(`
    SELECT id, cycle, target, period_start, period_end, pay_date, status, branch_id
    FROM payroll_periods WHERE id = ?
  `).get(periodId) as PayslipPeriod | undefined;
  if (!period) return null;

  const line = db.prepare(`
    SELECT ${LINE_COLS} FROM payroll_lines WHERE period_id = ? AND user_id = ?
  `).get(periodId, userId) as PayslipLine | undefined;
  if (!line) return null;

  const profile = db.prepare(`
    SELECT bank_name, bank_account, national_id, employee_code, title_prefix FROM users WHERE id = ?
  `).get(userId) as PayslipProfile | undefined;

  // Service-charge breakdown (display only) — recompute the month's SVC for the
  // employee's branch and pull their row so the slip can explain the figure.
  const svcMonth = period.period_start.slice(0, 7);
  let svcBranchId = period.branch_id;
  if (svcBranchId == null) {
    const ub = db.prepare(
      "SELECT branch_id FROM user_branches WHERE user_id = ? ORDER BY branch_id LIMIT 1"
    ).get(userId) as { branch_id: number } | undefined;
    svcBranchId = ub?.branch_id ?? null;
  }
  const svcSummary =
    svcBranchId != null && (line.service_charge > 0 || period.cycle === "monthly")
      ? computeMonthlySvcSummary(svcBranchId, svcMonth)
      : null;
  const svcRow = svcSummary?.rows.find((r) => r.userId === userId) ?? null;

  const payslipBranchName = period.branch_id
    ? (db.prepare("SELECT name FROM branches WHERE id = ?").get(period.branch_id) as { name: string } | undefined)?.name ?? null
    : null;

  const breakdown = buildLineBreakdown(db, periodId, userId);

  return {
    period,
    line,
    profile: profile ?? null,
    svcSummary,
    svcRow,
    payslipBranchName,
    dayLog: breakdown?.days ?? [],
    doublePremium: breakdown?.doublePremium ?? 0,
    ftMonthly: breakdown?.ftMonthly ?? false
  };
}
