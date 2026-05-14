import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  computeLineFromMinutes, type EmployeePayrollSnapshot, type PayrollSettings
} from "@/lib/payroll-compute";

// POST /api/admin/persona/payroll/periods/[id]/lines
// Add a single employee (zero-row) to an existing draft period.
// Useful when:
//   - period was created in manual mode and admin wants to include someone
//   - admin wants to add someone outside the eligible-staff filter
// The line starts at zero minutes/days; admin can edit it via the line PATCH.

const Body = z.object({
  user_id: z.number().int().positive()
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const periodId = Number(params.id);
  if (!Number.isInteger(periodId) || periodId <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { user_id: targetUserId } = parsed.data;

  const db = getDb();
  const period = db.prepare(`
    SELECT id, cycle, period_end, status FROM payroll_periods WHERE id = ?
  `).get(periodId) as
    { id: number; cycle: "weekly" | "monthly"; period_end: string; status: string } | undefined;
  if (!period) return NextResponse.json({ error: "period_not_found" }, { status: 404 });
  if (period.status !== "draft") {
    return NextResponse.json({ error: "must_be_draft" }, { status: 400 });
  }

  // Target must be a staff user (employment_type can be null — e.g. contractor)
  const target = db.prepare(`
    SELECT id, display_name, employment_type, employee_code,
           hourly_rate, monthly_salary, pay_cycle, salary_tax_mode
    FROM users WHERE id = ? AND role = 'staff'
  `).get(targetUserId) as {
    id: number;
    display_name: string;
    employment_type: "pt" | "ft" | null;
    employee_code: string | null;
    hourly_rate: number | null;
    monthly_salary: number | null;
    pay_cycle: "weekly" | "monthly" | null;
    salary_tax_mode: "sso" | "wht" | null;
  } | undefined;
  if (!target) return NextResponse.json({ error: "user_not_found" }, { status: 404 });

  // Already added? (UNIQUE constraint protects too, but give a friendly error)
  const existing = db.prepare(`
    SELECT id FROM payroll_lines WHERE period_id = ? AND user_id = ?
  `).get(periodId, targetUserId);
  if (existing) {
    return NextResponse.json({ error: "already_in_period" }, { status: 409 });
  }

  const settings = db.prepare(`
    SELECT ot_mode, ot_flat_per_15min,
           break_threshold_minutes, break_deduction_minutes,
           long_shift_threshold_minutes, long_shift_break_minutes,
           sso_rate, sso_cap, pt_default_hourly_rate, wht_rate
    FROM payroll_settings WHERE id = 1
  `).get() as PayrollSettings;

  const employee: EmployeePayrollSnapshot = {
    user_id: target.id,
    display_name: target.display_name,
    employment_type: target.employment_type,
    employee_code: target.employee_code,
    hourly_rate: target.hourly_rate,
    monthly_salary: target.monthly_salary,
    pay_cycle: target.pay_cycle,
    salary_tax_mode: target.salary_tax_mode
  };

  // Zero-row — admin will fill in hours/days afterward
  const computed = computeLineFromMinutes({
    employee,
    regularMinutes: 0,
    otMinutes: 0,
    holidayMinutes: 0,
    leaveDays: 0,
    daysWorked: 0,
    unpaired: 0,
    cycle: period.cycle,
    periodEnd: period.period_end,
    settings
  });

  db.prepare(`
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
  `).run(
    periodId, computed.user_id,
    computed.employee_code, computed.display_name, computed.employment_type,
    computed.pay_cycle_snapshot, computed.hourly_rate_snapshot, computed.monthly_salary_snapshot,
    computed.salary_tax_mode_snapshot,
    computed.shift_minutes, computed.break_deducted_minutes,
    computed.regular_minutes, computed.ot_minutes,
    computed.holiday_minutes,
    computed.days_worked, computed.leave_days, computed.unpaired_clockins,
    computed.base_pay, computed.ot_pay, computed.service_charge,
    computed.other_additions, computed.gross_pay,
    computed.sso_amount, computed.tax_amount, computed.other_deductions, computed.net_pay
  );

  return NextResponse.json({ ok: true });
}
