// Unit tests for the payroll compute — focused on the ลาไม่รับค่าจ้าง
// (unpaid leave) deduction added 2026-06-17. Run: npm run test:payroll
//
// Guarantees: salary/30 per unpaid day, FT only, default 0 = no change,
// and the deduction never drives base pay negative.

import { computeLineFromMinutes, type PayrollSettings, type EmployeePayrollSnapshot } from "../src/lib/payroll-compute";

const SETTINGS: PayrollSettings = {
  ot_mode: "flat", ot_flat_per_15min: 0,
  break_threshold_minutes: 360, break_deduction_minutes: 60,
  long_shift_threshold_minutes: 600, long_shift_break_minutes: 60,
  sso_rate: 0.05, sso_cap: 750, pt_default_hourly_rate: 50, wht_rate: 0.03
};

const ftMonthly = (salary: number): EmployeePayrollSnapshot => ({
  user_id: 1, display_name: "FT Example", employment_type: "ft", employee_code: "FT01",
  hourly_rate: null, monthly_salary: salary, pay_cycle: "monthly", salary_tax_mode: "sso",
  track_attendance: 1
});
const ptHourly = (rate: number): EmployeePayrollSnapshot => ({
  user_id: 2, display_name: "PT Example", employment_type: "pt", employee_code: "PT01",
  hourly_rate: rate, monthly_salary: null, pay_cycle: "monthly", salary_tax_mode: "sso",
  track_attendance: 1
});
// PT→FT transition month — FT on the weekly cycle (owner 2026-07-12).
const ftWeekly = (salary: number): EmployeePayrollSnapshot => ({
  ...ftMonthly(salary), pay_cycle: "weekly"
});

let pass = 0, fail = 0;
function eq(name: string, got: number, want: number) {
  const ok = Math.abs(got - want) < 0.005;
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}: got ${got}, want ${want}`); }
}

function line(emp: EmployeePayrollSnapshot, unpaidLeaveDays: number) {
  return computeLineFromMinutes({
    employee: emp, regularMinutes: 0, otMinutes: 0, holidayMinutes: 0,
    leaveDays: 0, unpaidLeaveDays, daysWorked: 0, unpaired: 0,
    cycle: "monthly", periodEnd: "2026-06-30", settings: SETTINGS
  });
}

console.log("ลาไม่รับค่าจ้าง deduction:");

// 1. Default 0 — full salary, no deduction (regression guard).
{
  const l = line(ftMonthly(30000), 0);
  eq("FT 0 unpaid → base 30000", l.base_pay, 30000);
  eq("FT 0 unpaid → deduction 0", l.unpaid_leave_deduction, 0);
}

// 2. FT 3 unpaid days on 30000 → 30000/30*3 = 3000 deducted.
{
  const l = line(ftMonthly(30000), 3);
  eq("FT 3 unpaid → deduction 3000", l.unpaid_leave_deduction, 3000);
  eq("FT 3 unpaid → base 27000", l.base_pay, 27000);
  eq("FT 3 unpaid → gross 27000", l.gross_pay, 27000);
  eq("FT 3 unpaid → days echoed", l.unpaid_leave_days, 3);
}

// 3. Half-day supported (salary/30 × 0.5).
{
  const l = line(ftMonthly(30000), 0.5);
  eq("FT 0.5 unpaid → deduction 500", l.unpaid_leave_deduction, 500);
}

// 4. PT — no salary, so no deduction even with unpaid days.
{
  const l = line(ptHourly(60), 5);
  eq("PT unpaid → deduction 0", l.unpaid_leave_deduction, 0);
}

// 5. Clamp — absurd unpaid days never push base negative.
{
  const l = line(ftMonthly(30000), 100); // 100*1000 = 100000 > 30000
  eq("FT clamp → deduction = base 30000", l.unpaid_leave_deduction, 30000);
  eq("FT clamp → base 0", l.base_pay, 0);
}

// 6. ผู้บริหาร (track_attendance=0) — เงินเดือน fix เต็ม, ไม่มี OT แม้กรอกนาที OT
//    (owner 2026-07-12). เทียบกับ FT ลงเวลา (track_attendance=1) ที่ได้ OT ปกติ.
console.log("\nผู้บริหาร (track_attendance=0) ไม่มี OT:");
{
  const otSettings: PayrollSettings = { ...SETTINGS, ot_mode: "flat", ot_flat_per_15min: 25 };
  const call = (track: number) => computeLineFromMinutes({
    employee: { ...ftMonthly(30000), track_attendance: track },
    regularMinutes: 480, otMinutes: 120, holidayMinutes: 0,
    leaveDays: 0, unpaidLeaveDays: 0, daysWorked: 1, unpaired: 0,
    cycle: "monthly", periodEnd: "2026-06-30", settings: otSettings
  });
  const exec = call(0);
  const tracked = call(1);
  eq("exec FT → base 30000 (fix เต็ม)", exec.base_pay, 30000);
  eq("exec FT → ot_pay 0", exec.ot_pay, 0);
  eq("tracked FT → ot_pay 200 (120min×25/15)", tracked.ot_pay, 200);
}

// 7. PT→FT เดือนแรก — จ่ายรายสัปดาห์ fix-rate (เงินเดือน ÷ #จันทร์) + WHT 3%
//    แม้ salary_tax_mode='sso' (transition บังคับ WHT). มิ.ย. 2026 มี 5 จันทร์.
console.log("\nPT→FT เดือนแรก (รายสัปดาห์ fix-rate + WHT 3%):");
{
  const l = computeLineFromMinutes({
    employee: ftWeekly(16000), regularMinutes: 0, otMinutes: 0, holidayMinutes: 0,
    leaveDays: 0, unpaidLeaveDays: 0, daysWorked: 0, unpaired: 0,
    cycle: "weekly", periodEnd: "2026-06-30", settings: SETTINGS
  });
  eq("FT-weekly base 16000/5 = 3200", l.base_pay, 3200);
  eq("FT-weekly WHT 3% = 96", l.tax_amount, 96);
  eq("FT-weekly SSO = 0", l.sso_amount, 0);
  eq("FT-weekly net = 3104", l.net_pay, 3104);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
