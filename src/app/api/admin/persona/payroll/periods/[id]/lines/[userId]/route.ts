import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { verifyAdminPin } from "@/lib/admin-pin";
import {
  computeLineFromMinutes, computeSso, computeWht,
  type EmployeePayrollSnapshot, type PayrollSettings
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
  unpaid_leave_days: z.number().min(0).max(366).optional(),
  days_worked: z.number().int().min(0).max(366).optional(),
  // Money-based fields
  base_pay: z.number().min(0).optional(),
  ot_pay: z.number().min(0).optional(),
  service_charge: z.number().min(0).optional(),
  other_additions: z.number().min(0).optional(),
  other_deductions: z.number().min(0).optional(),
  notes: z.string().max(500).optional(),
  // PIN gate — required for any manual edit to a payroll line (money
  // data). Verified against the admin's own users.pin_hash.
  admin_pin: z.string().optional()
});

export async function PATCH(
  req: Request,
  { params }: { params: { id: string; userId: string } }
) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

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

  // PIN gate — editing a payroll line touches money, so require the
  // admin to re-prove presence with their 4-digit PIN. (Owner spec
  // 2026-06-02.) Done BEFORE any DB work so a bad PIN changes nothing.
  if (!d.admin_pin) {
    return NextResponse.json({ error: "pin_required" }, { status: 400 });
  }
  const pinStatus = verifyAdminPin(user.id, d.admin_pin);
  if (!pinStatus.ok) {
    const code = pinStatus.reason === "no_pin" ? 400 : 403;
    return NextResponse.json({ error: pinStatus.reason }, { status: code });
  }

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
           days_worked, leave_days, unpaid_leave_days, unpaired_clockins,
           base_pay, ot_pay, service_charge, other_additions, other_deductions,
           gross_pay, net_pay, sso_amount, tax_amount
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
    days_worked: number; leave_days: number; unpaid_leave_days: number; unpaired_clockins: number;
    base_pay: number; ot_pay: number; service_charge: number;
    other_additions: number; other_deductions: number;
    gross_pay: number; net_pay: number;
    sso_amount: number; tax_amount: number;
  } | undefined;
  if (!line) return NextResponse.json({ error: "line_not_found" }, { status: 404 });

  // "Before" snapshot for the audit trail — captured prior to any write.
  const beforeSnapshot = {
    regular_minutes: line.regular_minutes, ot_minutes: line.ot_minutes,
    holiday_minutes: line.holiday_minutes, days_worked: line.days_worked,
    leave_days: line.leave_days,
    base_pay: line.base_pay, ot_pay: line.ot_pay,
    service_charge: line.service_charge, other_additions: line.other_additions,
    other_deductions: line.other_deductions,
    gross_pay: line.gross_pay, sso_amount: line.sso_amount,
    tax_amount: line.tax_amount, net_pay: line.net_pay
  };

  // Decide mode: (a) time-based if any time field provided; (b) money-based otherwise
  const timeFieldsProvided =
    d.regular_minutes !== undefined ||
    d.ot_minutes !== undefined ||
    d.holiday_minutes !== undefined ||
    d.leave_days !== undefined ||
    d.unpaid_leave_days !== undefined ||
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
      SELECT employment_type, hourly_rate, monthly_salary, pay_cycle, salary_tax_mode, track_attendance
      FROM users WHERE id = ?
    `).get(userId) as {
      employment_type: "pt" | "ft" | null;
      hourly_rate: number | null;
      monthly_salary: number | null;
      pay_cycle: "weekly" | "monthly" | null;
      salary_tax_mode: "sso" | "wht" | null;
      track_attendance: number | null;
    } | undefined;

    const employee: EmployeePayrollSnapshot = {
      user_id: line.user_id,
      display_name: line.display_name,
      employment_type: fresh?.employment_type ?? line.employment_type,
      employee_code: line.employee_code,
      hourly_rate: fresh?.hourly_rate ?? line.hourly_rate_snapshot,
      monthly_salary: fresh?.monthly_salary ?? line.monthly_salary_snapshot,
      pay_cycle: fresh?.pay_cycle ?? line.pay_cycle_snapshot,
      salary_tax_mode: fresh?.salary_tax_mode ?? line.salary_tax_mode_snapshot,
      track_attendance: fresh?.track_attendance ?? 1
    };

    const computed = computeLineFromMinutes({
      employee,
      regularMinutes: d.regular_minutes ?? line.regular_minutes,
      otMinutes: d.ot_minutes ?? line.ot_minutes,
      holidayMinutes: d.holiday_minutes ?? line.holiday_minutes,
      leaveDays: d.leave_days ?? line.leave_days,
      unpaidLeaveDays: d.unpaid_leave_days ?? line.unpaid_leave_days,
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
          days_worked = ?, leave_days = ?, unpaid_leave_days = ?,
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
      computed.days_worked, computed.leave_days, computed.unpaid_leave_days,
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
    // Mode (b) — money-only override
    // Recompute SSO/WHT based on the new gross + the employee's CURRENT
    // tax mode (not the line snapshot). This way, if admin types a base_pay
    // directly (e.g., 10,000 ฿), the system still applies SSO 5% / WHT 3%
    // automatically so net_pay reflects reality.
    const settings = db.prepare(`
      SELECT ot_mode, ot_flat_per_15min,
             break_threshold_minutes, break_deduction_minutes,
             long_shift_threshold_minutes, long_shift_break_minutes,
             sso_rate, sso_cap, pt_default_hourly_rate, wht_rate
      FROM payroll_settings WHERE id = 1
    `).get() as PayrollSettings;

    const fresh = db.prepare(`
      SELECT salary_tax_mode FROM users WHERE id = ?
    `).get(userId) as { salary_tax_mode: "sso" | "wht" | null } | undefined;
    const taxMode = fresh?.salary_tax_mode ?? line.salary_tax_mode_snapshot ?? "sso";

    const basePay = d.base_pay ?? line.base_pay;
    const otPay = d.ot_pay ?? line.ot_pay;
    const svcCharge = d.service_charge ?? line.service_charge;
    const otherAdd = d.other_additions ?? line.other_additions;
    const otherDed = d.other_deductions ?? line.other_deductions;
    const gross = basePay + otPay + svcCharge + otherAdd;

    let ssoAmount = 0;
    let taxAmount = 0;
    if (gross > 0) {
      if (taxMode === "wht") {
        taxAmount = computeWht(gross, settings);
      } else {
        // SSO on base salary only (excl OT/service/other) — owner 2026-07-04.
        ssoAmount = computeSso(basePay, period.cycle, settings);
      }
    }
    const net = gross - ssoAmount - taxAmount - otherDed;

    db.prepare(`
      UPDATE payroll_lines
      SET base_pay = ?, ot_pay = ?, service_charge = ?,
          other_additions = ?, other_deductions = ?,
          gross_pay = ?, sso_amount = ?, tax_amount = ?, net_pay = ?,
          salary_tax_mode_snapshot = ?,
          notes = COALESCE(?, notes),
          overridden = 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE period_id = ? AND user_id = ?
    `).run(
      basePay, otPay, svcCharge, otherAdd, otherDed,
      Math.round(gross * 100) / 100,
      Math.round(ssoAmount * 100) / 100,
      Math.round(taxAmount * 100) / 100,
      Math.round(net * 100) / 100,
      taxMode,
      d.notes ?? null,
      periodId, userId
    );
  }

  // Audit trail — read the stored row back so the "after" snapshot is
  // exactly what was persisted, then append an immutable audit row.
  const after = db.prepare(`
    SELECT regular_minutes, ot_minutes, holiday_minutes, days_worked, leave_days,
           base_pay, ot_pay, service_charge, other_additions, other_deductions,
           gross_pay, sso_amount, tax_amount, net_pay
    FROM payroll_lines WHERE period_id = ? AND user_id = ?
  `).get(periodId, userId);
  db.prepare(`
    INSERT INTO payroll_line_audit
      (period_id, target_user_id, admin_id, mode, before_json, after_json, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    periodId, userId, user.id,
    timeFieldsProvided ? "hours" : "amount",
    JSON.stringify(beforeSnapshot),
    JSON.stringify(after ?? {}),
    d.notes ?? null,
    new Date().toISOString()
  );
  logPersonaAction(user.id, "payroll.line.edit", periodId);

  return NextResponse.json({ ok: true });
}
