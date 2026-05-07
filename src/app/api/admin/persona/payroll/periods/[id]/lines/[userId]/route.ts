import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  computeLineFromMinutes, type EmployeePayrollSnapshot, type PayrollSettings
} from "@/lib/payroll-compute";

// PATCH /api/admin/persona/payroll/periods/[id]/lines/[userId]
// Manual override for one employee in one period. Two modes:
//
//   (a) Time-based override: admin provides minutes/days. System recomputes
//       base_pay, ot_pay, gross, sso, tax, net using employee's rate snapshot.
//
//   (b) Money-based override: admin provides money values directly. System
//       updates gross/net (keeps sso/tax as snapshot).
//
// Either mode marks the line as `overridden`. Allowed only while the period
// status is 'draft'.

const Body = z.object({
  // Time-based fields (any present → use mode (a))
  regular_minutes: z.number().int().min(0).max(100000).optional(),
  ot_minutes: z.number().int().min(0).max(100000).optional(),
  holiday_minutes: z.number().int().min(0).max(100000).optional(),
  leave_days: z.number().min(0).max(366).optional(),
  days_worked: z.number().int().min(0).max(366).optional(),
  // Money-based fields
  base_pay: z.number().min(0).optional(),
  ot_pay: z.number().min(0).optional(),
  service_charge: z.number().min(0).optional(),
  other_additions: z.number().min(0).optional(),
  other_deductions: z.number().min(0).optional(),
  notes: z.string().max(500).optional()
});

export async function PATCH(
  req: Request,
  { params }: { params: { id: string; userId: string } }
) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const periodId = Number(params.id);
  const userId = Number(params.userId);
  if (!Number.isInteger(periodId) || !Number.isInteger(userId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;

  const db = getDb();
  const period = db.prepare(`
    SELECT status, cycle, period_end FROM payroll_periods WHERE id = ?
  `).get(periodId) as
    { status: string; cycle: "weekly" | "monthly"; period_end: string } | undefined;
  if (!period) return NextResponse.json({ error: "period_not_found" }, { status: 404 });
  if (period.status !== "draft") {
    return NextResponse.json({ error: "must_be_draft" }, { status: 400 });
  }

  const line = db.prepare(`
    SELECT user_id, employee_code, display_name, employment_type,
           pay_cycle_snapshot, hourly_rate_snapshot, monthly_salary_snapshot,
           salary_tax_mode_snapshot,
           regular_minutes, ot_minutes, holiday_minutes,
           days_worked, leave_days, unpaired_clockins,
           base_pay, ot_pay, service_charge, other_additions, other_deductions,
           sso_amount, tax_amount
    FROM payroll_lines WHERE period_id = ? AND user_id = ?
  `).get(periodId, userId) as {
    user_id: number;
    employee_code: string | null;
    display_name: string;
    employment_type: "pt" | "ft" | null;
    pay_cycle_snapshot: "weekly" | "monthly" | null;
    hourly_rate_snapshot: number | null;
    monthly_salary_snapshot: number | null;
    salary_tax_mode_snapshot: "sso" | "wht" | null;
    regular_minutes: number; ot_minutes: number; holiday_minutes: number;
    days_worked: number; leave_days: number; unpaired_clockins: number;
    base_pay: number; ot_pay: number; service_charge: number;
    other_additions: number; other_deductions: number;
    sso_amount: number; tax_amount: number;
  } | undefined;
  if (!line) return NextResponse.json({ error: "line_not_found" }, { status: 404 });

  // Decide mode: (a) time-based if any time field provided; (b) money-based otherwise
  const timeFieldsProvided =
    d.regular_minutes !== undefined ||
    d.ot_minutes !== undefined ||
    d.holiday_minutes !== undefined ||
    d.leave_days !== undefined ||
    d.days_worked !== undefined;

  if (timeFieldsProvided) {
    // Mode (a) — recompute pay using minute totals + CURRENT user data
    // (not the original snapshot). This way, if admin updates the employee's
    // tax_mode / hourly_rate / monthly_salary on the employees page, the
    // line edit picks up the latest values automatically.
    const settings = db.prepare(`
      SELECT ot_mode, ot_flat_per_15min,
             break_threshold_minutes, break_deduction_minutes,
             long_shift_threshold_minutes, long_shift_break_minutes,
             sso_rate, sso_cap, pt_default_hourly_rate, wht_rate
      FROM payroll_settings WHERE id = 1
    `).get() as PayrollSettings;

    const fresh = db.prepare(`
      SELECT employment_type, hourly_rate, monthly_salary, pay_cycle, salary_tax_mode
      FROM users WHERE id = ?
    `).get(userId) as {
      employment_type: "pt" | "ft" | null;
      hourly_rate: number | null;
      monthly_salary: number | null;
      pay_cycle: "weekly" | "monthly" | null;
      salary_tax_mode: "sso" | "wht" | null;
    } | undefined;

    const employee: EmployeePayrollSnapshot = {
      user_id: line.user_id,
      display_name: line.display_name,
      employment_type: fresh?.employment_type ?? line.employment_type,
      employee_code: line.employee_code,
      hourly_rate: fresh?.hourly_rate ?? line.hourly_rate_snapshot,
      monthly_salary: fresh?.monthly_salary ?? line.monthly_salary_snapshot,
      pay_cycle: fresh?.pay_cycle ?? line.pay_cycle_snapshot,
      salary_tax_mode: fresh?.salary_tax_mode ?? line.salary_tax_mode_snapshot
    };

    const computed = computeLineFromMinutes({
      employee,
      regularMinutes: d.regular_minutes ?? line.regular_minutes,
      otMinutes: d.ot_minutes ?? line.ot_minutes,
      holidayMinutes: d.holiday_minutes ?? line.holiday_minutes,
      leaveDays: d.leave_days ?? line.leave_days,
      daysWorked: d.days_worked ?? line.days_worked,
      unpaired: line.unpaired_clockins,
      cycle: period.cycle,
      periodEnd: period.period_end,
      settings,
      serviceCharge: d.service_charge ?? line.service_charge,
      otherAdditions: d.other_additions ?? line.other_additions,
      otherDeductions: d.other_deductions ?? line.other_deductions
    });

    db.prepare(`
      UPDATE payroll_lines
      SET regular_minutes = ?, ot_minutes = ?, holiday_minutes = ?,
          days_worked = ?, leave_days = ?,
          base_pay = ?, ot_pay = ?, service_charge = ?,
          other_additions = ?, other_deductions = ?,
          gross_pay = ?, sso_amount = ?, tax_amount = ?, net_pay = ?,
          salary_tax_mode_snapshot = ?,
          hourly_rate_snapshot = ?, monthly_salary_snapshot = ?,
          pay_cycle_snapshot = ?,
          notes = COALESCE(?, notes),
          overridden = 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE period_id = ? AND user_id = ?
    `).run(
      computed.regular_minutes, computed.ot_minutes, computed.holiday_minutes,
      computed.days_worked, computed.leave_days,
      computed.base_pay, computed.ot_pay, computed.service_charge,
      computed.other_additions, computed.other_deductions,
      computed.gross_pay, computed.sso_amount, computed.tax_amount, computed.net_pay,
      computed.salary_tax_mode_snapshot,
      computed.hourly_rate_snapshot, computed.monthly_salary_snapshot,
      computed.pay_cycle_snapshot,
      d.notes ?? null,
      periodId, userId
    );
  } else {
    // Mode (b) — money-only override (keeps sso/tax as snapshot)
    const basePay = d.base_pay ?? line.base_pay;
    const otPay = d.ot_pay ?? line.ot_pay;
    const svcCharge = d.service_charge ?? line.service_charge;
    const otherAdd = d.other_additions ?? line.other_additions;
    const otherDed = d.other_deductions ?? line.other_deductions;
    const gross = basePay + otPay + svcCharge + otherAdd;
    const net = gross - line.sso_amount - line.tax_amount - otherDed;
    db.prepare(`
      UPDATE payroll_lines
      SET base_pay = ?, ot_pay = ?, service_charge = ?,
          other_additions = ?, other_deductions = ?,
          gross_pay = ?, net_pay = ?,
          notes = COALESCE(?, notes),
          overridden = 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE period_id = ? AND user_id = ?
    `).run(
      basePay, otPay, svcCharge, otherAdd, otherDed,
      Math.round(gross * 100) / 100, Math.round(net * 100) / 100,
      d.notes ?? null,
      periodId, userId
    );
  }

  return NextResponse.json({ ok: true });
}
