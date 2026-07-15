// Unit tests for the payroll compute — focused on the ลาไม่รับค่าจ้าง
// (unpaid leave) deduction added 2026-06-17. Run: npm run test:payroll
//
// Guarantees: salary/30 per unpaid day, FT only, default 0 = no change,
// and the deduction never drives base pay negative.

import { computeLineFromMinutes, computeLineForEmployee, type PayrollSettings, type EmployeePayrollSnapshot, type ScheduledShift } from "../src/lib/payroll-compute";

const SETTINGS: PayrollSettings = {
  ot_mode: "flat", ot_flat_per_15min: 0,
  break_threshold_minutes: 360, break_deduction_minutes: 60,
  long_shift_threshold_minutes: 600, long_shift_break_minutes: 60,
  sso_rate: 0.05, sso_cap: 750, pt_default_hourly_rate: 50, wht_rate: 0.03
};

const ftMonthly = (salary: number): EmployeePayrollSnapshot => ({
  user_id: 1, display_name: "FT Example", employment_type: "ft", employee_code: "FT01",
  hourly_rate: null, monthly_salary: salary, pay_cycle: "monthly", salary_tax_mode: "sso",
  track_attendance: 1, is_primary_branch: 1, hire_date: null, last_working_day: null
});
const ptHourly = (rate: number): EmployeePayrollSnapshot => ({
  user_id: 2, display_name: "PT Example", employment_type: "pt", employee_code: "PT01",
  hourly_rate: rate, monthly_salary: null, pay_cycle: "monthly", salary_tax_mode: "sso",
  track_attendance: 1, is_primary_branch: 1, hire_date: null, last_working_day: null
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
    cycle: "monthly", periodStart: "2026-06-01", periodEnd: "2026-06-30", settings: SETTINGS
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
    cycle: "monthly", periodStart: "2026-06-01", periodEnd: "2026-06-30", settings: otSettings
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
    cycle: "weekly", periodStart: "2026-06-01", periodEnd: "2026-06-30", settings: SETTINGS
  });
  eq("FT-weekly base 16000/5 = 3200", l.base_pay, 3200);
  eq("FT-weekly WHT 3% = 96", l.tax_amount, 96);
  eq("FT-weekly SSO = 0", l.sso_amount, 0);
  eq("FT-weekly net = 3104", l.net_pay, 3104);
}

// 8. OT ต้องได้รับอนุมัติก่อนถึงจะนับ (owner 2026-07-14) — คลิกเอาต์เกินเวลาเลิก
//    กะโดยไม่ขออนุมัติ ไม่ว่ากี่นาที ต้องไม่ขึ้นเป็น OT. ขออนุมัติแล้วถึงจะนับ.
console.log("\nOT ต้องได้รับอนุมัติก่อน (owner 2026-07-14):");
{
  const D = "2026-06-15";
  const iso = (hhmm: string) => new Date(`${D}T${hhmm}:00+07:00`).toISOString();
  // กะ 11:00–20:00 พัก 12:00–13:00 (= ทำงาน 8 ชม.). คลิกจริง 11:00–21:00 (เกิน 1 ชม.)
  const sched: ScheduledShift = {
    startTs: iso("11:00"), endTs: iso("20:00"),
    breakStartTs: iso("12:00"), breakEndTs: iso("13:00")
  };
  const scheduledByDate = new Map<string, ScheduledShift[]>([[D, [sched]]]);
  const shift = { startTs: iso("11:00"), endTs: iso("21:00"), durationMinutes: 600 };
  const base = {
    shifts: [shift], unpaired: 0, leaveDays: 0, unpaidLeaveDays: 0,
    cycle: "monthly" as const, periodStart: "2026-06-01", periodEnd: "2026-06-30", settings: SETTINGS,
    holidaySet: new Set<string>(), scheduledByDate
  };
  // FT ลงเวลา คลิกเกินกะ แต่ไม่ได้ขออนุมัติ OT → ต้อง cap ที่ 20:00 → OT = 0
  const noReq = computeLineForEmployee({ ...base, employee: { ...ftMonthly(30000), track_attendance: 1 } });
  eq("FT เกินกะ ไม่ขอ OT → ot_minutes 0", noReq.ot_minutes, 0);
  // ขออนุมัติถึง 21:00 → ต่อหน้าต่างถึง 21:00 → เกิน 8 ชม. = 60 นาที OT
  const withReq = computeLineForEmployee({
    ...base, employee: { ...ftMonthly(30000), track_attendance: 1 },
    approvedOtByDate: new Map<string, string>([[D, "21:00"]])
  });
  eq("FT ขอ OT ถึง 21:00 → ot_minutes 60", withReq.ot_minutes, 60);
  // PT ก็กติกาเดียวกัน — ไม่ขอ = 0
  const ptNoReq = computeLineForEmployee({ ...base, employee: ptHourly(50) });
  eq("PT เกินกะ ไม่ขอ OT → ot_minutes 0", ptNoReq.ot_minutes, 0);
  // ผู้บริหาร (track_attendance=0) แม้มีอนุมัติ OT ก็ไม่ได้ OT
  const exec = computeLineForEmployee({
    ...base, employee: { ...ftMonthly(30000), track_attendance: 0 },
    approvedOtByDate: new Map<string, string>([[D, "21:00"]])
  });
  eq("ผู้บริหารมีอนุมัติ OT → ot_minutes 0", exec.ot_minutes, 0);
}

// 9. FT เงินเดือนจ่ายเฉพาะสาขาหลัก (owner 2026-07-14) — พนักงานประจำที่สลับสาขา
//    ต้องได้เงินเดือนเต็มที่สาขาหลักเท่านั้น สาขาที่ไม่ใช่หลัก base = 0 (กัน
//    double-pay). PT ไม่กระทบ.
console.log("\nFT เงินเดือนเฉพาะสาขาหลัก (owner 2026-07-14):");
{
  const l = (emp: EmployeePayrollSnapshot) => computeLineFromMinutes({
    employee: emp, regularMinutes: 0, otMinutes: 0, holidayMinutes: 0,
    leaveDays: 0, unpaidLeaveDays: 0, daysWorked: 0, unpaired: 0,
    cycle: "monthly", periodStart: "2026-06-01", periodEnd: "2026-06-30", settings: SETTINGS
  });
  // สาขาหลัก → เงินเดือนเต็ม
  const primary = l({ ...ftMonthly(30000), is_primary_branch: 1 });
  eq("FT สาขาหลัก → base 30000", primary.base_pay, 30000);
  // สาขาไม่ใช่หลัก → base 0 (ไม่จ่ายเงินเดือนซ้ำ)
  const nonPrimary = l({ ...ftMonthly(30000), is_primary_branch: 0 });
  eq("FT สาขาไม่ใช่หลัก → base 0", nonPrimary.base_pay, 0);
  eq("FT สาขาไม่ใช่หลัก → gross 0", nonPrimary.gross_pay, 0);
  // PT ไม่สนใจ is_primary_branch — จ่ายตามชั่วโมงที่ทำสาขานั้นเสมอ
  const ptNon = computeLineFromMinutes({
    employee: { ...ptHourly(50), is_primary_branch: 0 },
    regularMinutes: 480, otMinutes: 0, holidayMinutes: 0,
    leaveDays: 0, unpaidLeaveDays: 0, daysWorked: 1, unpaired: 0,
    cycle: "monthly", periodStart: "2026-06-01", periodEnd: "2026-06-30", settings: SETTINGS
  });
  eq("PT สาขาไม่ใช่หลัก → base 400 (8ชม.×50)", ptNon.base_pay, 400);
}

// 10. เฉลี่ยเงินเดือน FT เดือนแรก/เดือนลาออก = เงินเดือน/30 × วันที่อยู่จริง (owner 2026-07-15).
//     ใช้เฉพาะเดือนที่เข้า/ออกกลางงวด — เดือนอยู่ครบไม่โดนหาร.
console.log("\nเฉลี่ยเงินเดือน FT เดือนแรก/เดือนลาออก (owner 2026-07-15):");
{
  // งวด ก.ค. 2026 (1-31, 31 วัน). manual path ใช้สาขาหลัก monthly.
  const jul = (emp: EmployeePayrollSnapshot) => computeLineFromMinutes({
    employee: emp, regularMinutes: 0, otMinutes: 0, holidayMinutes: 0,
    leaveDays: 0, unpaidLeaveDays: 0, daysWorked: 0, unpaired: 0,
    cycle: "monthly", periodStart: "2026-07-01", periodEnd: "2026-07-31", settings: SETTINGS
  });
  // เข้ากลางเดือน: เริ่ม 25 ก.ค. → อยู่ 25..31 = 7 วัน → 30000/30×7 = 7000
  const hired = jul({ ...ftMonthly(30000), hire_date: "2026-07-25" });
  eq("FT เข้า 25 ก.ค. → base 7000", hired.base_pay, 7000);
  // ลาออกกลางเดือน: วันสุดท้าย 20 ก.ค. → อยู่ 1..20 = 20 วัน → 30000/30×20 = 20000
  const resigned = jul({ ...ftMonthly(30000), last_working_day: "2026-07-20" });
  eq("FT ลาออก 20 ก.ค. → base 20000", resigned.base_pay, 20000);
  // อยู่ครบเดือน (เข้าก่อนงวด ไม่มีลาออก) → เต็ม (regression)
  const full = jul({ ...ftMonthly(30000), hire_date: "2026-05-01" });
  eq("FT อยู่ครบเดือน → base 30000", full.base_pay, 30000);
  // เข้าวันแรกของงวด → เต็ม (ไม่ prorate เพราะ hire_date = period_start)
  const day1 = jul({ ...ftMonthly(30000), hire_date: "2026-07-01" });
  eq("FT เข้า 1 ก.ค. → base 30000 (เต็ม)", day1.base_pay, 30000);
  // ก.พ. 28 วัน คนอยู่ครบเดือน → เต็ม ไม่ใช่ 30000/30×28 (ทดสอบ gate short month)
  const feb = computeLineFromMinutes({
    employee: { ...ftMonthly(30000), hire_date: "2026-01-10" },
    regularMinutes: 0, otMinutes: 0, holidayMinutes: 0, leaveDays: 0, unpaidLeaveDays: 0,
    daysWorked: 0, unpaired: 0, cycle: "monthly",
    periodStart: "2026-02-01", periodEnd: "2026-02-28", settings: SETTINGS
  });
  eq("FT ก.พ. อยู่ครบ → base 30000 (ไม่หาร 28)", feb.base_pay, 30000);
  // auto path (computeLineForEmployee) ต้อง prorate เหมือนกัน — เข้า 25 ก.ค. ไม่มีกะ
  const auto = computeLineForEmployee({
    employee: { ...ftMonthly(30000), hire_date: "2026-07-25" },
    shifts: [], unpaired: 0, leaveDays: 0, unpaidLeaveDays: 0,
    cycle: "monthly", periodStart: "2026-07-01", periodEnd: "2026-07-31",
    settings: SETTINGS, holidaySet: new Set<string>()
  });
  eq("auto: FT เข้า 25 ก.ค. → base 7000", auto.base_pay, 7000);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
