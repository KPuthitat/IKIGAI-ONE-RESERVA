// Unit tests for the payroll compute — focused on the ลาไม่รับค่าจ้าง
// (unpaid leave) deduction added 2026-06-17. Run: npm run test:payroll
//
// Guarantees: salary/30 per unpaid day, FT only, default 0 = no change,
// and the deduction never drives base pay negative.

import { computeLineFromMinutes, computeLineForEmployee, computeSso, computeHelperLine, countClockInDays, helperMode, applyPtGrace, keepEntryForBranch, overridesToShiftMap, type PayrollSettings, type EmployeePayrollSnapshot, type ScheduledShift, type EntryWithBranch } from "../src/lib/payroll-compute";

const SETTINGS: PayrollSettings = {
  ot_mode: "flat", ot_flat_per_15min: 0,
  break_threshold_minutes: 360, break_deduction_minutes: 60,
  long_shift_threshold_minutes: 600, long_shift_break_minutes: 60,
  sso_rate: 0.05, sso_cap: 750, pt_default_hourly_rate: 50, wht_rate: 0.03
};

const ftMonthly = (salary: number): EmployeePayrollSnapshot => ({
  user_id: 1, display_name: "FT Example", employment_type: "ft", employee_code: "FT01",
  hourly_rate: null, monthly_salary: salary, pay_cycle: "monthly", salary_tax_mode: "sso",
  track_attendance: 1, is_primary_branch: 1, is_home_company: 1, hire_date: null, last_working_day: null,
  ft_started_at: null
});
const ptHourly = (rate: number): EmployeePayrollSnapshot => ({
  user_id: 2, display_name: "PT Example", employment_type: "pt", employee_code: "PT01",
  hourly_rate: rate, monthly_salary: null, pay_cycle: "monthly", salary_tax_mode: "sso",
  track_attendance: 1, is_primary_branch: 1, is_home_company: 1, hire_date: null, last_working_day: null,
  ft_started_at: null
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
// Strict-equality assert for non-numbers (strings, null) — module-level so it's in
// scope everywhere (the branch-test block has its own local `ok`).
function okv(name: string, got: unknown, want: unknown) {
  if (got === want) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}: got ${String(got)}, want ${String(want)}`); }
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

// 7. PT→FT เดือนแรก — จ่ายรายวัน salary/30 × วันในสถานะ + WHT 3% (owner 2026-08-03)
//    แม้ salary_tax_mode='sso' (transition บังคับ WHT). 16000/30 × 6 วัน = 3200.
console.log("\nPT→FT เดือนแรก (รายวัน salary/30 + WHT 3%):");
{
  const l = computeLineFromMinutes({
    employee: ftWeekly(16000), regularMinutes: 0, otMinutes: 0, holidayMinutes: 0,
    leaveDays: 0, unpaidLeaveDays: 0, daysWorked: 6, unpaired: 0,
    cycle: "weekly", periodStart: "2026-06-01", periodEnd: "2026-06-30", settings: SETTINGS
  });
  eq("FT-weekly base 16000/30×6 = 3200", l.base_pay, 3200);
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

// 8b. เข้างานก่อนเวลาตามมอบหมาย — ต้องได้รับอนุมัติก่อนถึงจะนับเป็น OT
//     (owner 2026-07-28, สมมาตรกับ OT อยู่เกินเวลา). อนุมัติ → หน้าต่างเริ่มจาก
//     เวลาที่ตอกเข้าจริง เกิน 8 ชม. = OT. ไม่อนุมัติ → นับเข้างานตามกะ.
console.log("\nเข้าก่อนเวลา ต้องอนุมัติก่อนถึงนับ OT (owner 2026-07-28):");
{
  const D = "2026-06-16";
  const iso = (hhmm: string) => new Date(`${D}T${hhmm}:00+07:00`).toISOString();
  // กะ 11:00–20:00 พัก 12:00–13:00 (= ทำงาน 8 ชม.). ตอกเข้าเร็ว 10:00 เลิกตามกะ 20:00
  const sched: ScheduledShift = {
    startTs: iso("11:00"), endTs: iso("20:00"),
    breakStartTs: iso("12:00"), breakEndTs: iso("13:00")
  };
  const scheduledByDate = new Map<string, ScheduledShift[]>([[D, [sched]]]);
  const shift = { startTs: iso("10:00"), endTs: iso("20:00"), durationMinutes: 600 };
  const base = {
    shifts: [shift], unpaired: 0, leaveDays: 0, unpaidLeaveDays: 0,
    cycle: "monthly" as const, periodStart: "2026-06-01", periodEnd: "2026-06-30", settings: SETTINGS,
    holidaySet: new Set<string>(), scheduledByDate
  };
  // ไม่อนุมัติ → คลิกเข้าเร็วถูก clamp เป็น 11:00 → ทำงาน 8 ชม. → OT 0
  const ptNoApprove = computeLineForEmployee({ ...base, employee: ptHourly(50) });
  eq("PT เข้าเร็ว ไม่อนุมัติ → regular 480", ptNoApprove.regular_minutes, 480);
  eq("PT เข้าเร็ว ไม่อนุมัติ → OT 0", ptNoApprove.ot_minutes, 0);
  eq("PT เข้าเร็ว ไม่อนุมัติ → base 400", ptNoApprove.base_pay, 400);
  // อนุมัติ requested_from=10:00 → หน้าต่างเริ่ม 10:00 → ทำงาน 9 ชม. → OT 60
  const ptApprove = computeLineForEmployee({
    ...base, employee: ptHourly(50),
    approvedEarlyByDate: new Map<string, string>([[D, "10:00"]])
  });
  eq("PT เข้าเร็ว อนุมัติ → regular 480", ptApprove.regular_minutes, 480);
  eq("PT เข้าเร็ว อนุมัติ 10:00 → OT 60", ptApprove.ot_minutes, 60);
  eq("PT เข้าเร็ว อนุมัติ → base ยัง 400 (OT แยก)", ptApprove.base_pay, 400);
  // อนุมัติ requested_from เวลาช้ากว่าที่ตอกเข้า → นับจากเวลาที่อนุมัติ (floor)
  const shiftEarlier = { startTs: iso("09:30"), endTs: iso("20:00"), durationMinutes: 630 };
  const ptFloor = computeLineForEmployee({
    ...base, shifts: [shiftEarlier], employee: ptHourly(50),
    approvedEarlyByDate: new Map<string, string>([[D, "10:00"]])
  });
  eq("PT ตอก 09:30 อนุมัติแค่ 10:00 → OT 60 (ไม่ใช่ 90)", ptFloor.ot_minutes, 60);
  // อนุมัติแต่รวมยังไม่ถึง 8 ชม. → OT 0 (เลิก 16:00: 10:00–16:00 พัก 1 ชม = 5 ชม.)
  const shortShift = { startTs: iso("10:00"), endTs: iso("16:00"), durationMinutes: 360 };
  const ptShort = computeLineForEmployee({
    ...base, shifts: [shortShift], employee: ptHourly(50),
    approvedEarlyByDate: new Map<string, string>([[D, "10:00"]])
  });
  eq("PT เข้าเร็ว อนุมัติ แต่รวม<8ชม → OT 0", ptShort.ot_minutes, 0);
  // ผู้บริหาร (track_attendance=0) แม้อนุมัติเข้าเร็ว ก็ไม่ได้ OT
  const exec = computeLineForEmployee({
    ...base, employee: { ...ftMonthly(30000), track_attendance: 0 },
    approvedEarlyByDate: new Map<string, string>([[D, "10:00"]])
  });
  eq("ผู้บริหาร เข้าเร็วอนุมัติ → OT 0", exec.ot_minutes, 0);
  // OT pay ไหลถูก: flat 25฿/15นาที × 4 บล็อก = 100
  const otSettings: PayrollSettings = { ...SETTINGS, ot_mode: "flat", ot_flat_per_15min: 25 };
  const ptPay = computeLineForEmployee({
    ...base, settings: otSettings, employee: ptHourly(50),
    approvedEarlyByDate: new Map<string, string>([[D, "10:00"]])
  });
  eq("PT เข้าเร็ว อนุมัติ → ot_pay 100 (4×25)", ptPay.ot_pay, 100);
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

// 10. เฉลี่ยเงินเดือน FT เดือนแรก/เดือนลาออก = เงินเดือน/30 × วันที่มาทำงานจริง (owner 2026-07-15).
//     ใช้เฉพาะเดือนที่ "เข้า" (เดือนแรก รวมเข้าวันที่ 1) และเดือนที่ "ลาออก" —
//     เดือนที่อยู่ครบทั้งเดือนไม่โดนหักตามวัน.
console.log("\nเฉลี่ยเงินเดือน FT เดือนแรก/เดือนลาออก = /30 × วันที่มาทำงาน (owner 2026-07-15):");
{
  // งวด ก.ค. 2026. manual path: daysWorked = จำนวนวันที่มาลงเวลาจริง.
  const jul = (emp: EmployeePayrollSnapshot, daysWorked: number) => computeLineFromMinutes({
    employee: emp, regularMinutes: 0, otMinutes: 0, holidayMinutes: 0,
    leaveDays: 0, unpaidLeaveDays: 0, daysWorked, unpaired: 0,
    cycle: "monthly", periodStart: "2026-07-01", periodEnd: "2026-07-31", settings: SETTINGS
  });
  // เข้ากลางเดือน 25 ก.ค. มาทำงาน 5 วัน → 30000/30×5 = 5000
  eq("FT เข้า 25 ก.ค. ทำงาน 5 วัน → base 5000",
    jul({ ...ftMonthly(30000), hire_date: "2026-07-25" }, 5).base_pay, 5000);
  // เข้าเป็น FT ตั้งแต่วันที่ 1 (เดือนแรก) แต่มาทำงาน 20 วัน → 30000/30×20 = 20000
  eq("FT เข้า 1 ก.ค. ทำงาน 20 วัน → base 20000",
    jul({ ...ftMonthly(30000), hire_date: "2026-07-01" }, 20).base_pay, 20000);
  // ลาออก 20 ก.ค. มาทำงาน 18 วัน → 30000/30×18 = 18000
  eq("FT ลาออก 20 ก.ค. ทำงาน 18 วัน → base 18000",
    jul({ ...ftMonthly(30000), last_working_day: "2026-07-20" }, 18).base_pay, 18000);
  // อยู่ครบเดือน (เข้าก่อนงวด ไม่มีลาออก) → เต็ม แม้ daysWorked ต่ำ (ไม่ใช่เดือนเข้า/ออก)
  eq("FT อยู่ครบเดือน → base 30000 (ไม่หักตามวัน)",
    jul({ ...ftMonthly(30000), hire_date: "2026-05-01" }, 0).base_pay, 30000);
  // cap: เดือนเข้า ทำงาน 31 วัน → min(30000, 30000/30×31) = 30000
  eq("FT เดือนเข้า ทำงาน 31 วัน → base 30000 (cap)",
    jul({ ...ftMonthly(30000), hire_date: "2026-07-01" }, 31).base_pay, 30000);
  // auto path — นับวันจากกะจริง (25..31 ก.ค. = 7 วัน) → 30000/30×7 = 7000
  const iso = (d: string, hhmm: string) => new Date(`2026-07-${d}T${hhmm}:00+07:00`).toISOString();
  const shifts = Array.from({ length: 7 }, (_, i) => {
    const day = String(25 + i).padStart(2, "0");
    return { startTs: iso(day, "09:00"), endTs: iso(day, "17:00"), durationMinutes: 480 };
  });
  const auto = computeLineForEmployee({
    employee: { ...ftMonthly(30000), hire_date: "2026-07-25" },
    shifts, unpaired: 0, leaveDays: 0, unpaidLeaveDays: 0,
    cycle: "monthly", periodStart: "2026-07-01", periodEnd: "2026-07-31",
    settings: SETTINGS, holidaySet: new Set<string>()
  });
  eq("auto: FT เข้า 25 ก.ค. มีกะ 7 วัน → days_worked 7", auto.days_worked, 7);
  eq("auto: FT เข้า 25 ก.ค. → base 7000", auto.base_pay, 7000);
}

// 11. PT→ประจำ เดือนเปลี่ยนผ่าน คิดตาม ft_started_at เทียบเดือนของรอบ (owner 2026-07-16)
//     — ต้องถูกไม่ว่าจะคิดสดหรือกรอกย้อนหลัง. ธนะรัตน์เปลี่ยน 10 มิ.ย.
console.log("\nPT→ประจำ เดือนเปลี่ยนผ่าน: ฐานรายวัน salary/30 × วันในสถานะ + WHT (owner 2026-08-03):");
{
  const conv = (salary: number): EmployeePayrollSnapshot =>
    ({ ...ftMonthly(salary), ft_started_at: "2026-06-10" });
  const run = (emp: EmployeePayrollSnapshot, cycle: "weekly" | "monthly", pStart: string, pEnd: string, days: number) =>
    computeLineFromMinutes({
      employee: emp, regularMinutes: 0, otMinutes: 0, holidayMinutes: 0,
      leaveDays: 0, unpaidLeaveDays: 0, daysWorked: days, unpaired: 0,
      cycle, periodStart: pStart, periodEnd: pEnd, settings: SETTINGS
    });
  // รอบ WEEKLY เปลี่ยนผ่าน → รายวัน 30000/30 × 6 วัน = 6000, บังคับ WHT 3%
  const wkJun = run(conv(30000), "weekly", "2026-06-01", "2026-06-30", 6);
  eq("เปลี่ยนผ่าน weekly → รายวัน 30000/30×6 = 6000", wkJun.base_pay, 6000);
  eq("เปลี่ยนผ่าน weekly → WHT 3% บังคับ (6000×0.03)", wkJun.tax_amount, 180);
  // รอบ MONTHLY มิ.ย. → ยังไม่ใช่เดือน monthly ของเขา → base 0
  const moJun = run(conv(30000), "monthly", "2026-06-01", "2026-06-30", 20);
  eq("เปลี่ยนผ่าน มิ.ย. รอบ monthly → base 0 (ไม่อยู่ตารางประจำ)", moJun.base_pay, 0);
  // รอบ MONTHLY ก.ค. (เลยเปลี่ยนผ่าน, เต็มเดือน) → เต็ม 30000 + ประกันสังคม (ไม่ WHT)
  const moJul = run(conv(30000), "monthly", "2026-07-01", "2026-07-31", 22);
  eq("เดือนถัดจากเปลี่ยนผ่าน (ก.ค.) → base 30000 เต็ม", moJul.base_pay, 30000);
  eq("ประจำเต็มเดือน → ไม่หัก WHT (ใช้ประกันสังคม)", moJul.tax_amount, 0);
  // legacy FT (ft_started_at=null, ไม่ใช่เดือนเข้า) รอบ monthly → เต็ม (regression)
  const legacy = run(ftMonthly(30000), "monthly", "2026-06-01", "2026-06-30", 22);
  eq("legacy FT รอบ monthly → base 30000", legacy.base_pay, 30000);
}

// 11c. เดือนเปลี่ยนผ่าน weekly: ทุกสัปดาห์จ่ายฐานรายวัน salary/30 × วันในสถานะ.
//      รอบคร่อมเดือน — กฎ A (owner 2026-08-18): วันของเดือนถัดไปไม่จ่ายในรอบสัปดาห์
//      (ยกไปรอบเดือนนั้น) → จ่ายเฉพาะวันของเดือนเปลี่ยนผ่าน.
console.log("\nเดือนเปลี่ยนผ่าน weekly: จ่ายฐานรายวัน + กฎคร่อมเดือน (owner 2026-08-18):");
{
  const conv = (salary: number): EmployeePayrollSnapshot => ({ ...ftMonthly(salary), ft_started_at: "2026-07-10" });
  const runRound = (pStart: string, pEnd: string, doubleDate: string | null) => {
    const dd = doubleDate ?? "2026-07-22";
    const iso = (hhmm: string) => new Date(`${dd}T${hhmm}:00+07:00`).toISOString();
    const sched: ScheduledShift = { startTs: iso("11:00"), endTs: iso("19:00"), breakStartTs: null, breakEndTs: null };
    const shift = { startTs: iso("11:00"), endTs: iso("19:00"), durationMinutes: 480 };
    return computeLineForEmployee({
      employee: conv(16000), shifts: doubleDate ? [shift] : [], unpaired: 0, leaveDays: 0, unpaidLeaveDays: 0,
      cycle: "weekly", periodStart: pStart, periodEnd: pEnd,
      settings: SETTINGS, holidaySet: new Set<string>(),
      doubleSet: doubleDate ? new Set<string>([doubleDate]) : new Set<string>(),
      scheduledByDate: doubleDate ? new Map<string, ScheduledShift[]>([[doubleDate, [sched]]]) : new Map<string, ScheduledShift[]>()
    });
  };
  const daily = 16000 / 30;
  const base7 = Math.round(daily * 7 * 100) / 100;   // อยู่ในสถานะ 7 วัน
  const plain = runRound("2026-07-20", "2026-07-26", null);
  eq("รอบ weekly 7 วัน (ในเดือน) → ฐาน 16000/30×7", plain.base_pay, base7);
  // กฎ A — รอบคร่อมเดือน 27/07–02/08: จ่ายเฉพาะวัน ก.ค. (27–31 = 5 วัน) · ส.ค. ยกไปรอบเดือน
  const base5July = Math.round(daily * 5 * 100) / 100;
  const spill = runRound("2026-07-27", "2026-08-02", null);
  eq("กฎ A: รอบคร่อมเดือน → จ่ายเฉพาะวันเดือนเปลี่ยนผ่าน (ก.ค. 5 วัน)", spill.base_pay, base5July);
  // วันคูณสอง: ฐานรายวัน 7 วัน + ส่วนเกินคูณสองอีก 1 วัน (8ชม.)
  const dbl = runRound("2026-07-20", "2026-07-26", "2026-07-22");
  eq("รอบมีวันคูณสอง → ฐานรายวัน + คูณสองส่วนเกิน", dbl.base_pay, Math.round((base7 + daily) * 100) / 100);
  eq("เปลี่ยนผ่าน weekly → หัก WHT ไม่ใช่ SSO", dbl.sso_amount === 0 && dbl.tax_amount > 0 ? 1 : 0, 1);

  // กฎ B (owner 2026-08-18) — ft_salary_paid_through: เดือนเปลี่ยนผ่านจ่ายครบด้วยวิธีเก่า
  // แล้ว → รอบคร่อมเดือนถัดไปไม่คิดฐานของวัน ≤ วันนั้น (OT + คูณสองยังจ่าย). ตั้ง 31 ก.ค.
  // → รอบ 27/07–02/08 ฐาน = 0 (ก.ค.จ่ายครบ · ส.ค.ยกไปรอบเดือน).
  const paidThrough = (salary: number): EmployeePayrollSnapshot =>
    ({ ...ftMonthly(salary), ft_started_at: "2026-07-10", ft_salary_paid_through: "2026-07-31" });
  const runPT = (pStart: string, pEnd: string, doubleDate: string | null) => {
    const dd = doubleDate ?? "2026-07-28";
    const iso = (hhmm: string) => new Date(`${dd}T${hhmm}:00+07:00`).toISOString();
    const sched: ScheduledShift = { startTs: iso("11:00"), endTs: iso("19:00"), breakStartTs: null, breakEndTs: null };
    const shift = { startTs: iso("11:00"), endTs: iso("19:00"), durationMinutes: 480 };
    return computeLineForEmployee({
      employee: paidThrough(16000), shifts: doubleDate ? [shift] : [], unpaired: 0, leaveDays: 0, unpaidLeaveDays: 0,
      cycle: "weekly", periodStart: pStart, periodEnd: pEnd,
      settings: SETTINGS, holidaySet: new Set<string>(),
      doubleSet: doubleDate ? new Set<string>([doubleDate]) : new Set<string>(),
      scheduledByDate: doubleDate ? new Map<string, ScheduledShift[]>([[doubleDate, [sched]]]) : new Map<string, ScheduledShift[]>()
    });
  };
  // ไม่มีวันคูณสอง → ฐาน 0 ล้วน (ก.ค.จ่ายครบ, ส.ค.ยกไป)
  const ptSpill = runPT("2026-07-27", "2026-08-02", null);
  eq("กฎ B: จ่ายครบถึง 31 ก.ค. → ฐานรอบคร่อมเดือน = 0", ptSpill.base_pay, 0);
  // มีวันคูณสอง 28 ก.ค. (≤ paid_through) → ฐานปกติ = 0 แต่พรีเมียมคูณสอง 1 วัน (8ชม.) ยังจ่าย
  const ptDbl = runPT("2026-07-27", "2026-08-02", "2026-07-28");
  eq("กฎ B: วันคูณสอง ≤ จ่ายครบ → ยังได้พรีเมียม 1 วัน (ฐาน=0)", ptDbl.base_pay, Math.round(daily * 100) / 100);
}

// 11e. เข้าใหม่เป็นประจำ เดือนแรก: รายวัน salary/30 × วันในสถานะ, จ่ายวันที่ 5, WHT (owner 2026-08-03)
console.log("\nเข้าใหม่ประจำ เดือนแรก: รายวัน salary/30 × วันในสถานะ + WHT (owner 2026-08-03):");
{
  const newFt = (hire: string): EmployeePayrollSnapshot =>
    ({ ...ftMonthly(30000), ft_started_at: null, hire_date: hire });
  // AUTO path (นับวันตามปฏิทิน): เข้า 1 ส.ค. ทำเต็มเดือน → 31 วันในสถานะ, cap เต็ม 30000
  const autoFull = computeLineForEmployee({
    employee: newFt("2026-08-01"), shifts: [], unpaired: 0, leaveDays: 0, unpaidLeaveDays: 0,
    cycle: "monthly", periodStart: "2026-08-01", periodEnd: "2026-08-31",
    settings: SETTINGS, holidaySet: new Set<string>(), doubleSet: new Set<string>()
  });
  eq("เข้า 1 ส.ค. ทำเต็มเดือน → เต็ม 30000 (cap)", autoFull.base_pay, 30000);
  eq("เข้าใหม่เดือนแรก → หัก WHT ไม่ใช่ SSO", autoFull.sso_amount === 0 && autoFull.tax_amount > 0 ? 1 : 0, 1);
  // AUTO: เข้า 16 ส.ค. → วันในสถานะ 16..31 = 16 วัน → 30000/30×16 = 16000
  const autoMid = computeLineForEmployee({
    employee: newFt("2026-08-16"), shifts: [], unpaired: 0, leaveDays: 0, unpaidLeaveDays: 0,
    cycle: "monthly", periodStart: "2026-08-01", periodEnd: "2026-08-31",
    settings: SETTINGS, holidaySet: new Set<string>(), doubleSet: new Set<string>()
  });
  eq("เข้า 16 ส.ค. → 30000/30×16วัน = 16000", autoMid.base_pay, 16000);
}

// 11d. ลงเวลาทำงานวันหยุดแทนพนักงาน (owner 2026-08-03) — admin กรอกวันที่พนักงานไม่ได้
//      ลงเวลา. มีเวลาจริง → ใช้เวลาจริง; ไม่มีเวลาจริงแต่มีเวลากะ → ใช้เวลากะเป็นกะทำงาน.
console.log("\nลงเวลาวันหยุดแทนพนักงาน — สังเคราะห์กะจากเวลากะเมื่อไม่มีเวลาจริง (owner 2026-08-03):");
{
  const D = "2026-08-10";
  const clockPair = overridesToShiftMap([
    { work_date: D, clock_in: "10:00", clock_out: "18:00", sched_in: "11:00", sched_out: "19:00" }
  ]).get(D);
  eq("มีเวลาเข้า–ออก → ใช้เวลาจริง (8ชม.)", clockPair?.durationMinutes ?? -1, 480);
  const schedOnly = overridesToShiftMap([
    { work_date: D, clock_in: null, clock_out: null, sched_in: "11:00", sched_out: "19:00" }
  ]).get(D);
  eq("ไม่มีเวลาจริง แต่มีเวลากะ → สร้างกะจากเวลากะ (8ชม.)", schedOnly?.durationMinutes ?? -1, 480);
  const nothing = overridesToShiftMap([{ work_date: D, clock_in: null, clock_out: null }]).get(D);
  eq("ไม่มีทั้งเวลาจริงและเวลากะ → ไม่มีกะ (null)", nothing === null ? 1 : 0, 1);
}

// 11f. Phase B — ขาดงานมีกะแต่ไม่มา+ไม่ลา → หัก salary/30 (owner 2026-08-03),
//      เฉพาะกลุ่มรายวัน (เข้าใหม่/เปลี่ยนผ่าน) ไม่กระทบกลุ่ม 4 / PT.
console.log("\nPhase B: ขาดงานมีกะไม่ลา → หัก salary/30 (owner 2026-08-03):");
{
  const emp = (): EmployeePayrollSnapshot => ({ ...ftMonthly(30000), hire_date: "2026-08-01", ft_started_at: null });
  const iso = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00+07:00`).toISOString();
  const sched = (d: string): ScheduledShift => ({ startTs: iso(d, "11:00"), endTs: iso(d, "19:00"), breakStartTs: null, breakEndTs: null });
  const scheduledByDate = new Map<string, ScheduledShift[]>([
    ["2026-08-05", [sched("2026-08-05")]],
    ["2026-08-06", [sched("2026-08-06")]]   // มีกะ work ทั้งคู่
  ]);
  const workedShift = { startTs: iso("2026-08-05", "11:00"), endTs: iso("2026-08-05", "19:00"), durationMinutes: 480 };
  const base = {
    employee: emp(), shifts: [workedShift], unpaired: 0, leaveDays: 0, unpaidLeaveDays: 0,
    cycle: "monthly" as const, periodStart: "2026-08-01", periodEnd: "2026-08-31",
    settings: SETTINGS, holidaySet: new Set<string>(), doubleSet: new Set<string>(), scheduledByDate
  };
  // 08-05 มาทำ, 08-06 มีกะแต่ไม่มา+ไม่ลา → ขาด 1 วัน
  const noShow = computeLineForEmployee({ ...base });
  eq("ขาดงาน 08-06 → นับเป็นวันหัก 1 (unpaid_leave_days)", noShow.unpaid_leave_days, 1);
  // 08-06 มีใบลา → ไม่นับขาด
  const onLeave = computeLineForEmployee({ ...base, leaveDates: new Set<string>(["2026-08-06"]) });
  eq("08-06 ลาแล้ว → ไม่หักขาดงาน", onLeave.unpaid_leave_days, 0);
  eq("ผลต่างฐาน (ขาด vs ลา) = 30000/30 = 1000", Math.round((onLeave.base_pay - noShow.base_pay) * 100) / 100, 1000);
  // กลุ่ม 4 (ประจำเต็มเดือน, hire null) → Phase B ไม่แตะ
  const g4 = computeLineForEmployee({ ...base, employee: ftMonthly(30000) });
  eq("ประจำเต็มเดือน (กลุ่ม 4) → ไม่หักขาดงาน", g4.unpaid_leave_days, 0);
}

// N. วันจ่ายสองเท่า (owner 2026-07-21) — พนักงานทุกคนที่ทำงานวันที่ตั้งไว้ ได้ฐาน+OT ×2.
console.log("\nวันจ่ายสองเท่า (owner 2026-07-21):");
{
  const D = "2026-06-15";
  const iso = (hhmm: string) => new Date(`${D}T${hhmm}:00+07:00`).toISOString();
  const sched: ScheduledShift = {
    startTs: iso("11:00"), endTs: iso("20:00"), breakStartTs: iso("12:00"), breakEndTs: iso("13:00")
  }; // กะ 8 ชม.
  const scheduledByDate = new Map<string, ScheduledShift[]>([[D, [sched]]]);
  const shift = { startTs: iso("11:00"), endTs: iso("21:00"), durationMinutes: 600 }; // เกินกะ 1 ชม.
  const approvedOtByDate = new Map<string, string>([[D, "21:00"]]);   // ขอ OT ถึง 21:00 → 60 นาที
  const base = {
    shifts: [shift], unpaired: 0, leaveDays: 0, unpaidLeaveDays: 0,
    cycle: "monthly" as const, periodStart: "2026-06-01", periodEnd: "2026-06-30", settings: SETTINGS,
    holidaySet: new Set<string>(), scheduledByDate, approvedOtByDate
  };
  const dbl = new Set<string>([D]);

  // PT rate 50/ชม.: ฐาน 8ชม.×50 = 400 → วัน 2 เท่า = 800; OT ×2.
  const ptN = computeLineForEmployee({ ...base, employee: ptHourly(50) });
  const ptD = computeLineForEmployee({ ...base, employee: ptHourly(50), doubleSet: dbl });
  eq("PT วัน 2 เท่า → ฐาน ×2 (400→800)", ptD.base_pay, Math.round(ptN.base_pay * 2 * 100) / 100);
  eq("PT วัน 2 เท่า → OT ×2", ptD.ot_pay, Math.round(ptN.ot_pay * 2 * 100) / 100);
  eq("PT วัน 2 เท่า → นาทีเท่าเดิม", ptD.ot_minutes, ptN.ot_minutes);

  // FT เงินเดือน 30000: ฐานคงเดิม + 1 วันเทียบเท่า (125/ชม.×8 = 1000) = 31000; OT ×2.
  const ftN = computeLineForEmployee({ ...base, employee: { ...ftMonthly(30000), track_attendance: 1 } });
  const ftD = computeLineForEmployee({ ...base, employee: { ...ftMonthly(30000), track_attendance: 1 }, doubleSet: dbl });
  eq("FT วัน 2 เท่า → ฐาน +1 วันเทียบเท่า (30000→31000)", ftD.base_pay, 31000);
  eq("FT วัน 2 เท่า → OT ×2", ftD.ot_pay, Math.round(ftN.ot_pay * 2 * 100) / 100);

  // วันปกติ (ไม่อยู่ใน doubleSet) → ไม่เปลี่ยน.
  eq("วันที่ไม่ได้ตั้ง 2 เท่า → PT ฐานปกติ", ptN.base_pay, 400);
}

// 11. ทำงานข้ามบริษัท (owner 2026-07-29) — พรนภา สังกัด AT HOME ไปช่วย NAMA/EMIA
//     รายชั่วโมง 70 บาท. ประกันสังคมหักที่บริษัทต้นสังกัดเท่านั้น (AT HOME ส่งให้แล้ว)
//     → สาขาบริษัทอื่น (is_home_company=0) ไม่หัก SSO; บริษัทตัวเอง (=1) หักปกติ.
//     ค่าจ้าง/ฐาน/gross เท่ากันทุกที่ — ต่างแค่ยอดหัก.
console.log("\nทำงานข้ามบริษัท — SSO หักเฉพาะบริษัทต้นสังกัด:");
{
  const mins = {
    regularMinutes: 480, otMinutes: 0, holidayMinutes: 0,
    leaveDays: 0, unpaidLeaveDays: 0, daysWorked: 1, unpaired: 0,
    cycle: "monthly" as const, periodStart: "2026-06-01", periodEnd: "2026-06-30", settings: SETTINGS
  };
  // ใช้ FT ประจำเต็มเดือน (กลุ่ม 4 = ประกันสังคม) เพราะ PT ตอนนี้บังคับ WHT (owner 2026-08-03)
  const home = computeLineFromMinutes({ employee: { ...ftMonthly(30000), is_home_company: 1 }, ...mins });
  const away = computeLineFromMinutes({ employee: { ...ftMonthly(30000), is_home_company: 0 }, ...mins });
  eq("home vs away: ฐานเท่ากัน", away.base_pay, home.base_pay);
  eq("home vs away: gross เท่ากัน", away.gross_pay, home.gross_pay);
  eq("home: หัก SSO = 5% ฐาน", home.sso_amount, computeSso(home.base_pay, "monthly", SETTINGS));
  eq("home: net = gross - SSO", home.net_pay, Math.round((home.gross_pay - home.sso_amount) * 100) / 100);
  eq("away: ไม่หัก SSO", away.sso_amount, 0);
  eq("away: net = gross (ไม่มีหักเลย)", away.net_pay, away.gross_pay);
}

// 12. ข้ามบริษัทกระทบเฉพาะ SSO — โหมด WHT ยังหัก 3% ณ ที่จ่ายตามปกติ
//     (ผู้จ่ายที่บริษัทปลายทางเป็นผู้หัก) แม้ is_home_company=0.
{
  const mins = {
    regularMinutes: 480, otMinutes: 0, holidayMinutes: 0,
    leaveDays: 0, unpaidLeaveDays: 0, daysWorked: 1, unpaired: 0,
    cycle: "monthly" as const, periodStart: "2026-06-01", periodEnd: "2026-06-30", settings: SETTINGS
  };
  const whtAway = computeLineFromMinutes({ employee: { ...ptHourly(70), salary_tax_mode: "wht", is_home_company: 0 }, ...mins });
  eq("away+WHT: SSO 0", whtAway.sso_amount, 0);
  eq("away+WHT: ยังหัก 3%", whtAway.tax_amount, Math.round(whtAway.gross_pay * 0.03 * 100) / 100);
}

// 13. บริษัทเดียวหลายสาขา (NAMA+HYPO) ต้องไม่เปลี่ยน — is_home_company=1
//     ทั้งสาขาหลักและสาขารอง เพราะเทียบระดับ "บริษัท" ไม่ใช่ "สาขา".
{
  const mins = {
    regularMinutes: 480, otMinutes: 0, holidayMinutes: 0,
    leaveDays: 0, unpaidLeaveDays: 0, daysWorked: 1, unpaired: 0,
    cycle: "monthly" as const, periodStart: "2026-06-01", periodEnd: "2026-06-30", settings: SETTINGS
  };
  // สาขารองในบริษัทเดียวกัน: is_primary_branch=0 แต่ is_home_company=1 → SSO ยังหัก.
  // ใช้ FT ประจำเต็มเดือน (PT ตอนนี้บังคับ WHT — owner 2026-08-03).
  const otherBranchSameCo = computeLineFromMinutes({ employee: { ...ftMonthly(30000), is_primary_branch: 0, is_home_company: 1 }, ...mins });
  eq("บริษัทเดียว สาขารอง: SSO ยังหักปกติ", otherBranchSameCo.sso_amount, computeSso(otherBranchSameCo.base_pay, "monthly", SETTINGS));
}

// 14. applyPtGrace — 5-นาที grace ต้องนับเวลาเข้า/ออกตามกะทั้งสองฝั่ง
//     (owner 2026-07-30 bug: มาสาย 3 นาทีในช่วง grace แต่โดนตัด 3 นาที เพราะฝั่ง
//     กดเข้าไม่ snap กลับไปเวลากะ ต่างจากฝั่งกดออกที่ snap ถูก).
console.log("\napplyPtGrace 5-min grace (เข้า/ออกตามกะ):");
{
  // Shift 11:00–20:00 (+07), no scheduled break — 9h = 540 นาที.
  const sched: ScheduledShift = {
    startTs: "2026-07-26T11:00:00+07:00", endTs: "2026-07-26T20:00:00+07:00",
    breakStartTs: null, breakEndTs: null
  };
  const g = (inHHMM: string, outHHMM: string) =>
    applyPtGrace(
      { startTs: `2026-07-26T${inHHMM}:00+07:00`, endTs: `2026-07-26T${outHHMM}:00+07:00` },
      sched
    );

  // มาสาย 3 นาที (11:03) — ในช่วง grace → นับตั้งแต่ 11:00 = เต็ม 540, ไม่ late
  const late3 = g("11:03", "20:00");
  eq("เข้า 11:03 (สาย 3 นาที) → gross 540 เต็ม", late3.grossMinutes, 540);
  eq("เข้า 11:03 → lateMinutes 0", late3.lateMinutes, 0);

  // ตรงเวลาเป๊ะ → 540 (regression)
  eq("เข้า 11:00 ตรงเวลา → gross 540", g("11:00", "20:00").grossMinutes, 540);

  // สายเกิน grace (11:10) → นับจริงจาก 11:10 = 530, late 10
  const late10 = g("11:10", "20:00");
  eq("เข้า 11:10 (สายเกิน grace) → gross 530", late10.grossMinutes, 530);
  eq("เข้า 11:10 → lateMinutes 10", late10.lateMinutes, 10);

  // ออกก่อน 3 นาที (19:57) — ในช่วง grace → นับถึง 20:00 = เต็ม 540 (ฝั่งออกยังถูก)
  eq("ออก 19:57 (ก่อน 3 นาที) → gross 540 เต็ม", g("11:00", "19:57").grossMinutes, 540);

  // ออกก่อนเกิน grace (19:50) → นับจริงถึง 19:50 = 530, early 10
  const early10 = g("11:00", "19:50");
  eq("ออก 19:50 (ก่อนเกิน grace) → gross 530", early10.grossMinutes, 530);
  eq("ออก 19:50 → earlyMinutes 10", early10.earlyMinutes, 10);

  // มาก่อนเวลา (10:30) ไม่มี OT อนุมัติ → นับจาก 11:00 (ทิ้งเวลาก่อนกะ) = 540
  eq("เข้า 10:30 (ก่อนเวลา) → gross 540 (ไม่จ่ายก่อนกะ)", g("10:30", "20:00").grossMinutes, 540);
}

// 15. Born-FT new hire (ไม่เคยเป็น PT) — ft_started_at NULL + pay_cycle monthly.
//     เดือนแรกที่ไม่เต็มต้องคิดรายวัน (salary/30 × วันทำจริง) จ่ายรอบรายเดือน —
//     ไม่ใช่หารรายสัปดาห์ และไม่ใช่ WHT รอบเปลี่ยนผ่าน (owner 2026-07-30 · สุริยะ).
console.log("\nborn-FT รับเข้าใหม่รายเดือน (prorate เดือนแรก):");
{
  const mins = {
    regularMinutes: 0, otMinutes: 0, holidayMinutes: 0,
    leaveDays: 0, unpaidLeaveDays: 0, unpaired: 0,
    cycle: "monthly" as const, periodStart: "2026-06-01", periodEnd: "2026-06-30", settings: SETTINGS
  };
  // เข้าใหม่กลางเดือน (16 มิ.ย.) ทำงาน 10 วัน → 30000/30×10 = 10000
  const bornFtPartial: EmployeePayrollSnapshot = {
    ...ftMonthly(30000), hire_date: "2026-06-16", ft_started_at: null, pay_cycle: "monthly"
  };
  const p = computeLineFromMinutes({ employee: bornFtPartial, daysWorked: 10, ...mins });
  eq("born-FT เดือนแรก 10 วัน → base 10000 (รายวัน ไม่ใช่รายสัปดาห์)", p.base_pay, 10000);
  // owner 2026-08-03: เข้าใหม่ประจำ "เดือนแรก" = หัก ณ ที่จ่าย 3% (ยังไม่เข้าประกันสังคม)
  eq("born-FT เดือนแรก → หัก WHT 3% ไม่ใช่ SSO", p.tax_amount, 300); // 10000×0.03
  eq("born-FT เดือนแรก → SSO = 0", p.sso_amount, 0);

  // อยู่มาก่อนเดือนนี้ (จ้าง 1 พ.ค.) → เต็มเดือน 30000
  const bornFtFull: EmployeePayrollSnapshot = {
    ...ftMonthly(30000), hire_date: "2026-05-01", ft_started_at: null, pay_cycle: "monthly"
  };
  const f = computeLineFromMinutes({ employee: bornFtFull, daysWorked: 22, ...mins });
  eq("born-FT เดือนเต็ม → base 30000", f.base_pay, 30000);
}

// ── Per-day branch reattribution (owner 2026-07-31) ───────────────────
// keepEntryForBranch decides whether a punch belongs to a given branch's
// period. The move must be SYMMETRIC: a day reattributed from A→B leaves A's
// period AND enters B's, so exactly one branch books it (no double count).
console.log("\nการย้ายสาขารายวัน (per-day branch reattribution):");
{
  const ok = (name: string, got: boolean, want: boolean) => {
    if (got === want) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}: got ${got}, want ${want}`); }
  };
  const BRANCH_A = 1, BRANCH_B = 2;
  // 2026-06-15 11:00 BKK = 04:00Z → bkkDate 2026-06-15.
  const punchAtA: EntryWithBranch = { id: 100, user_id: 7, ts: "2026-06-15T04:00:00.000Z", type: "in", branch_id: BRANCH_A };
  const key = "7|2026-06-15";
  const noReass = new Map<string, number>();
  const reassToB = new Map<string, number>([[key, BRANCH_B]]);
  const noCerts = new Set<number>();

  // No reattribution → belongs to its punched branch only.
  ok("ไม่ย้าย: punch สาขา A → อยู่ในรอบ A", keepEntryForBranch(punchAtA, BRANCH_A, noReass, noCerts), true);
  ok("ไม่ย้าย: punch สาขา A → ไม่อยู่ในรอบ B", keepEntryForBranch(punchAtA, BRANCH_B, noReass, noCerts), false);

  // Reattributed A→B → leaves A, enters B (the core move).
  ok("ย้าย A→B: หลุดจากรอบ A", keepEntryForBranch(punchAtA, BRANCH_A, reassToB, noCerts), false);
  ok("ย้าย A→B: เข้ารอบ B", keepEntryForBranch(punchAtA, BRANCH_B, reassToB, noCerts), true);

  // Reattribution wins over an approved cert (would otherwise be included).
  const certForA = new Set<number>([100]);
  ok("ย้าย A→B ชนะ cert: หลุดจาก A แม้เป็น cert", keepEntryForBranch(punchAtA, BRANCH_A, reassToB, certForA), false);
  ok("ย้าย A→B ชนะ cert: เข้า B", keepEntryForBranch(punchAtA, BRANCH_B, reassToB, certForA), true);

  // Approved cert with NULL branch, no reattribution → included anywhere.
  const nullBranchCert: EntryWithBranch = { id: 101, user_id: 7, ts: "2026-06-15T04:00:00.000Z", type: "out", branch_id: null };
  ok("cert branch NULL: เข้ารอบ A ได้", keepEntryForBranch(nullBranchCert, BRANCH_A, noReass, new Set([101])), true);
  ok("cert branch NULL: เข้ารอบ B ได้", keepEntryForBranch(nullBranchCert, BRANCH_B, noReass, new Set([101])), true);
  ok("ไม่ใช่ cert + branch NULL: ไม่เข้ารอบ A", keepEntryForBranch(nullBranchCert, BRANCH_A, noReass, noCerts), false);

  // Approved cert stamped at a KNOWN branch (B) must NOT leak into another
  // branch's period (A) — else a cross-branch worker's day is counted twice
  // (owner 2026-08-01: ศรุตา นามะ+ไฮโป รวมกันเกินยอดจริง).
  const certAtB: EntryWithBranch = { id: 102, user_id: 7, ts: "2026-06-15T04:00:00.000Z", type: "in", branch_id: BRANCH_B };
  ok("cert สาขา B: เข้ารอบ B (สาขาตัวเอง)", keepEntryForBranch(certAtB, BRANCH_B, noReass, new Set([102])), true);
  ok("cert สาขา B: ไม่รั่วเข้ารอบ A", keepEntryForBranch(certAtB, BRANCH_A, noReass, new Set([102])), false);

  // Legacy all-branches period (branchId null) keeps everything.
  ok("รอบเก่าไม่ผูกสาขา: เก็บทุก punch", keepEntryForBranch(punchAtA, null, reassToB, noCerts), true);
}

// ── Cross-company/branch day-rate helper (owner 2026-08-17) ────────────
// พรนภา สังกัด AT HOME (FT) ไปช่วยอีกบริษัท 350/วัน × 3 วัน = 1,050; หัก ณ ที่จ่าย
// 3% โดยบริษัทผู้จ่าย (31.50), ไม่หักประกันสังคม → net 1,018.50.
console.log("\nผู้ช่วยข้ามบริษัท (จ่ายรายวัน):");
{
  // FT at another company, set as a day-rate helper at THIS branch.
  const helper: EmployeePayrollSnapshot = {
    user_id: 9, display_name: "พรนภา", employment_type: "ft", employee_code: "AH01",
    hourly_rate: null, monthly_salary: 25000, pay_cycle: "monthly", salary_tax_mode: "sso",
    track_attendance: 1, is_primary_branch: 0, is_home_company: 0,
    hire_date: null, last_working_day: null, ft_started_at: null, daily_rate: 350
  };
  const h = computeHelperLine({ employee: helper, clockInDays: 3, settings: SETTINGS });
  eq("helper 350×3 → base 1050", h.base_pay, 1050);
  eq("helper → WHT 3% = 31.5", h.tax_amount, 31.5);
  eq("helper → SSO 0 (ข้ามบริษัท)", h.sso_amount, 0);
  eq("helper → net 1018.5", h.net_pay, 1018.5);
  eq("helper → days_worked 3", h.days_worked, 3);
  eq("helper → is_helper flag 1", h.is_helper ?? 0, 1);
  eq("helper → no OT", h.ot_pay, 0);

  // 0 days → 0 pay (skipped in the full compute, but the fn must be safe).
  const h0 = computeHelperLine({ employee: helper, clockInDays: 0, settings: SETTINGS });
  eq("helper 0 วัน → base 0", h0.base_pay, 0);
  eq("helper 0 วัน → tax 0", h0.tax_amount, 0);

  // computeLineFromMinutes must route a daily_rate employee to the helper path,
  // ignoring hours entirely (flat daily). daysWorked drives the count.
  const viaMinutes = computeLineFromMinutes({
    employee: helper, regularMinutes: 999, otMinutes: 480, holidayMinutes: 0,
    leaveDays: 0, daysWorked: 3, unpaired: 0,
    cycle: "weekly", periodStart: "2026-08-03", periodEnd: "2026-08-09", settings: SETTINGS
  });
  eq("helper via minutes → base 1050 (ignores hours)", viaMinutes.base_pay, 1050);
  eq("helper via minutes → no OT", viaMinutes.ot_pay, 0);
  eq("helper via minutes → is_helper 1", viaMinutes.is_helper ?? 0, 1);

  // A normal FT (no daily_rate) is unaffected — regression guard.
  const normalFt = computeLineFromMinutes({
    employee: ftMonthly(30000), regularMinutes: 0, otMinutes: 0, holidayMinutes: 0,
    leaveDays: 0, daysWorked: 0, unpaired: 0,
    cycle: "monthly", periodStart: "2026-08-01", periodEnd: "2026-08-31", settings: SETTINGS
  });
  eq("normal FT unaffected → base 30000", normalFt.base_pay, 30000);
  eq("normal FT unaffected → is_helper 0", normalFt.is_helper ?? 0, 0);

  // daily_rate = 0 must NOT be treated as a helper (a mistaken 0 shouldn't zero
  // someone's real pay). Falls through to the normal FT engine.
  const zeroRate = computeLineFromMinutes({
    employee: { ...helper, daily_rate: 0 }, regularMinutes: 0, otMinutes: 0, holidayMinutes: 0,
    leaveDays: 0, daysWorked: 3, unpaired: 0,
    cycle: "weekly", periodStart: "2026-08-03", periodEnd: "2026-08-09", settings: SETTINGS
  });
  eq("daily_rate 0 → not a helper", zeroRate.is_helper ?? 0, 0);

  // Admin money extras on a helper's hours-PATCH are preserved (not discarded).
  // base 1050 + additions 200 = gross 1250; WHT 3% = 37.5; − deduction 50 = 1162.5.
  const withExtras = computeLineFromMinutes({
    employee: helper, regularMinutes: 0, otMinutes: 0, holidayMinutes: 0,
    leaveDays: 0, daysWorked: 3, unpaired: 0,
    cycle: "weekly", periodStart: "2026-08-03", periodEnd: "2026-08-09", settings: SETTINGS,
    otherAdditions: 200, otherDeductions: 50
  });
  eq("helper + extras → gross 1250", withExtras.gross_pay, 1250);
  eq("helper + extras → WHT 37.5", withExtras.tax_amount, 37.5);
  eq("helper + extras → net 1162.5", withExtras.net_pay, 1162.5);
  eq("helper + extras → additions kept", withExtras.other_additions, 200);
}

// ── Hourly helper (owner 2026-08-18) — FT ข้ามบริษัทที่จ่ายรายชั่วโมง ────────
// คิดเหมือน PT: ชั่วโมงจริง × เรต (+OT/วันพิเศษ×1.5), WHT 3%, ไม่หัก SSO.
console.log("\nผู้ช่วยข้ามบริษัท (จ่ายรายชั่วโมง):");
{
  const hourlyHelper: EmployeePayrollSnapshot = {
    user_id: 10, display_name: "อรุณ", employment_type: "ft", employee_code: "AH02",
    hourly_rate: null, monthly_salary: 25000, pay_cycle: "monthly", salary_tax_mode: "sso",
    track_attendance: 1, is_primary_branch: 0, is_home_company: 0,
    hire_date: null, last_working_day: null, ft_started_at: null,
    daily_rate: null, branch_hourly_rate: 60
  };
  // helperMode gating
  okv("helperMode: FT + เรตรายชั่วโมงต่อสาขา + ไม่ใช่สาขาหลัก → hourly", helperMode(hourlyHelper), "hourly");
  okv("helperMode: daily_rate ชนะ (→ daily)", helperMode({ ...hourlyHelper, daily_rate: 350 }), "daily");
  okv("helperMode: สาขาหลัก → ไม่ใช่ helper (null)", helperMode({ ...hourlyHelper, is_primary_branch: 1 }), null);
  okv("helperMode: PT ปกติ → null", helperMode(ptHourly(60)), null);

  // 8 ชม. × 60 = 480; WHT 3% = 14.4; SSO 0; net 465.6.
  const hh = computeLineFromMinutes({
    employee: hourlyHelper, regularMinutes: 480, otMinutes: 0, holidayMinutes: 0,
    leaveDays: 0, daysWorked: 1, unpaired: 0,
    cycle: "weekly", periodStart: "2026-08-03", periodEnd: "2026-08-09", settings: SETTINGS
  });
  eq("hourly helper 8ชม.×60 → base 480", hh.base_pay, 480);
  eq("hourly helper → WHT 3% = 14.4", hh.tax_amount, 14.4);
  eq("hourly helper → SSO 0 (ข้ามบริษัท)", hh.sso_amount, 0);
  eq("hourly helper → net 465.6", hh.net_pay, 465.6);
  eq("hourly helper → is_helper 2", hh.is_helper ?? 0, 2);
  // Computed with PT math but stores the REAL employment_type (ft) — is_helper
  // carries the distinction, so reports still see the true type.
  okv("hourly helper → เก็บ employment_type เดิม (ft)", hh.employment_type, "ft");

  // OT: with flat OT 25/15min, 60 OT min = 4×25 = 100 on top of base.
  const otHH = computeLineFromMinutes({
    employee: hourlyHelper, regularMinutes: 480, otMinutes: 60, holidayMinutes: 0,
    leaveDays: 0, daysWorked: 1, unpaired: 0,
    cycle: "weekly", periodStart: "2026-08-03", periodEnd: "2026-08-09",
    settings: { ...SETTINGS, ot_mode: "flat", ot_flat_per_15min: 25 }
  });
  eq("hourly helper → มี OT (flat 25/15น. × 4 = 100)", otHH.ot_pay, 100);
}

// countClockInDays — distinct Bangkok dates with a clock-IN (owner 2026-08-17).
console.log("\nนับวันที่มีลงเวลา (helper):");
{
  const entries = [
    { ts: "2026-08-03T02:00:00.000Z", type: "in" },   // 09:00 BKK, 3 Aug
    { ts: "2026-08-03T10:00:00.000Z", type: "out" },  // out same day
    { ts: "2026-08-04T02:00:00.000Z", type: "in" },   // 4 Aug
    { ts: "2026-08-04T03:00:00.000Z", type: "in" },   // 2nd in same day — still 1 day
    { ts: "2026-08-05T18:30:00.000Z", type: "in" }    // 01:30 BKK 6 Aug (crosses UTC midnight)
  ];
  eq("3 วันแยกกัน (นับ in, ข้าม out, ดีดัพวัน)", countClockInDays(entries), 3);
  eq("ไม่มี in → 0 วัน", countClockInDays([{ ts: "2026-08-03T10:00:00.000Z", type: "out" }]), 0);
}

// ── FT→PT switch (pt_started_at) + no-clock PT from roster (owner 2026-08-31) ──
console.log("\nเปลี่ยนประจำ→พาร์ทไทม์ (วันที่เริ่ม) + พาร์ทไทม์ไม่ลงเวลา:");
{
  const sept5: ScheduledShift = {
    startTs: "2026-09-05T03:00:00.000Z",  // 10:00 BKK
    endTs:   "2026-09-05T08:00:00.000Z"   // 15:00 BKK → 5h, no break
  };
  const sepRoster = new Map<string, ScheduledShift[]>([["2026-09-05", [sept5]]]);
  // Stored as FT (keeps her in the monthly run) + keeps salary; hourly rate for
  // after the switch; ไม่ต้องลงเวลา (track_attendance 0); becomes PT on 1 ก.ย.
  const emp: EmployeePayrollSnapshot = {
    ...ftMonthly(30000), hourly_rate: 50, track_attendance: 0, pt_started_at: "2026-09-01"
  };

  // AUGUST (before the switch) → still FULL-TIME: flat salary, snapshot 'ft'.
  const aug = computeLineForEmployee({
    employee: emp, shifts: [], unpaired: 0, leaveDays: 0,
    cycle: "monthly", periodStart: "2026-08-01", periodEnd: "2026-08-31",
    settings: SETTINGS, holidaySet: new Set<string>()
  });
  okv("ส.ค. (ก่อนสลับ) = ประจำ", aug.employment_type, "ft");
  eq("ส.ค. ได้เงินเดือนเต็ม 30000", aug.base_pay, 30000);

  // SEPTEMBER (from the switch) → PART-TIME, hours from the roster (no clock):
  // 5h × 50 = 250, WHT 3% = 7.5, no SSO.
  const sep = computeLineForEmployee({
    employee: emp, shifts: [], unpaired: 0, leaveDays: 0,
    cycle: "monthly", periodStart: "2026-09-01", periodEnd: "2026-09-30",
    settings: SETTINGS, holidaySet: new Set<string>(), scheduledByDate: sepRoster
  });
  okv("ก.ย. (หลังสลับ) = พาร์ทไทม์", sep.employment_type, "pt");
  eq("ก.ย. คิดจากกะ 5 ชม × 50 = 250", sep.base_pay, 250);
  eq("ก.ย. หัก ณ ที่จ่าย 3% = 7.5", sep.tax_amount, 7.5);
  eq("ก.ย. ไม่มีประกันสังคม", sep.sso_amount, 0);
  eq("ก.ย. สุทธิ = 242.5", sep.net_pay, 242.5);
  eq("ก.ย. นับ 1 วันทำงาน", sep.days_worked, 1);

  // A plain PT with track_attendance=1 but NO clock + NO roster → 0 (regression:
  // roster path only kicks in for the no-clock flag).
  const noHours = computeLineForEmployee({
    employee: ptHourly(50), shifts: [], unpaired: 0, leaveDays: 0,
    cycle: "monthly", periodStart: "2026-09-01", periodEnd: "2026-09-30",
    settings: SETTINGS, holidaySet: new Set<string>(), scheduledByDate: sepRoster
  });
  eq("PT ปกติ (ลงเวลา) ไม่มีบัตร → 0", noHours.base_pay, 0);
}

// ── Doctor Fee (DF) — owner 2026-08 ──────────────────────────────
// From df_started_at's month a doctor earns a Doctor Fee (passed in as
// dfAmount) instead of ค่าเวร: zero base/OT, gross = net = DF, no WHT/SSO.
{
  const doc = (): EmployeePayrollSnapshot => ({ ...ptHourly(50), df_started_at: "2026-09-01" });
  // Roster on Sep 3 (would normally earn hourly pay), but DF is active → 0 ค่าเวร.
  const sched: ScheduledShift = { startTs: "2026-09-03T09:00:00+07:00", endTs: "2026-09-03T14:00:00+07:00" };
  const roster = new Map<string, ScheduledShift[]>([["2026-09-03", [sched]]]);

  // SEPTEMBER (DF active) with a fee of 14,160.
  const sep = computeLineForEmployee({
    employee: { ...doc(), track_attendance: 0 }, shifts: [], unpaired: 0, leaveDays: 0,
    cycle: "monthly", periodStart: "2026-09-01", periodEnd: "2026-09-30",
    settings: SETTINGS, holidaySet: new Set<string>(), scheduledByDate: roster, dfAmount: 14160, dfBranchPeriod: true
  });
  eq("DF: ค่าเวร (base) = 0", sep.base_pay, 0);
  eq("DF: OT = 0", sep.ot_pay, 0);
  eq("DF: other_additions = ค่าตอบแทน 14160", sep.other_additions, 14160);
  eq("DF: gross = 14160", sep.gross_pay, 14160);
  eq("DF: ไม่หัก ณ ที่จ่าย", sep.tax_amount, 0);
  eq("DF: ไม่มีประกันสังคม", sep.sso_amount, 0);
  eq("DF: net = 14160 (จ่ายเต็ม)", sep.net_pay, 14160);

  // AUGUST (before df_started_at's month) → DF inactive, normal PT (roster hourly).
  const augRoster = new Map<string, ScheduledShift[]>([
    ["2026-08-05", [{ startTs: "2026-08-05T09:00:00+07:00", endTs: "2026-08-05T14:00:00+07:00" }]]
  ]);
  const aug = computeLineForEmployee({
    employee: { ...doc(), track_attendance: 0 }, shifts: [], unpaired: 0, leaveDays: 0,
    cycle: "monthly", periodStart: "2026-08-01", periodEnd: "2026-08-31",
    settings: SETTINGS, holidaySet: new Set<string>(), scheduledByDate: augRoster, dfAmount: 14160, dfBranchPeriod: true
  });
  eq("DF: ก่อนเดือนเริ่ม ไม่คิด DF (ค่าเวรตามเดิม 5ชม×50=250)", aug.base_pay, 250);
  eq("DF: ก่อนเดือนเริ่ม other_additions = 0", aug.other_additions, 0);

  // A non-DF employee with a stray dfAmount passed → ignored entirely.
  const nonDf = computeLineForEmployee({
    employee: ptHourly(50), shifts: [], unpaired: 0, leaveDays: 0,
    cycle: "monthly", periodStart: "2026-09-01", periodEnd: "2026-09-30",
    settings: SETTINGS, holidaySet: new Set<string>(), scheduledByDate: roster, dfAmount: 9999, dfBranchPeriod: true
  });
  eq("DF: พนักงานไม่ใช่ DF → dfAmount ถูกเมิน (additions 0)", nonDf.other_additions, 0);

  // At a NON-DF branch (dfBranchPeriod false), a DF doctor's shift still pays
  // ค่าเวร normally — DF replaces CLINIC pay only, never other branches' shifts.
  const otherBranch = computeLineForEmployee({
    employee: { ...doc(), track_attendance: 0 }, shifts: [], unpaired: 0, leaveDays: 0,
    cycle: "monthly", periodStart: "2026-09-01", periodEnd: "2026-09-30",
    settings: SETTINGS, holidaySet: new Set<string>(), scheduledByDate: roster, dfAmount: 0, dfBranchPeriod: false
  });
  eq("DF: สาขาที่ไม่ใช่คลินิก → จ่ายค่าเวรตามปกติ (5ชม×50=250)", otherBranch.base_pay, 250);
  eq("DF: สาขาที่ไม่ใช่คลินิก → ไม่มี DF (additions 0)", otherBranch.other_additions, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
