// วันหยุดประเพณีสะสม — traditionalHolidayAccruedDays (owner 2026-08-03)
// Run: node --import tsx scripts/verify-holiday-accrual.ts
import { traditionalHolidayAccruedDays } from "../src/lib/leave";

let fails = 0;
function eq(label: string, got: number, want: number) {
  const ok = Math.abs(got - want) < 1e-9;
  console.log(`${ok ? "✓" : "✗"} ${label} (got ${got}, want ${want})`);
  if (!ok) fails++;
}

// 13/ปี, 13/12 ≈ 1.0833/เดือน, min เพดาน 13
const PM = 13 / 12;
// เข้างานก่อนปีนี้ → เต็มปี = 13
eq("hired long ago, ปลายปี → 13", traditionalHolidayAccruedDays("2024-01-01", 2026, "2026-12-15"), 13);
// เข้ากลางปี (ก.ค.) → ก.ค.–ธ.ค. = 6 เดือน
eq("hired ก.ค. → ธ.ค. = 6 เดือน", traditionalHolidayAccruedDays("2026-07-10", 2026, "2026-12-31"), Math.round(6 * PM * 100) / 100);
// เพิ่งเข้าเดือนนี้ → 1 เดือน
eq("hired มี.ค. ณ มี.ค. → 1 เดือน", traditionalHolidayAccruedDays("2026-03-05", 2026, "2026-03-20"), Math.round(PM * 100) / 100);
// ม.ค. (เข้านานแล้ว) → 1 เดือน
eq("ม.ค. → 1 เดือน", traditionalHolidayAccruedDays("2024-01-01", 2026, "2026-01-10"), Math.round(PM * 100) / 100);
// asOf ก่อนปีที่ขอ → 0
eq("asOf ก่อนปี → 0", traditionalHolidayAccruedDays("2024-01-01", 2026, "2025-12-01"), 0);
// เข้างานปีหน้า → 0
eq("hired ปีหน้า → 0", traditionalHolidayAccruedDays("2027-01-01", 2026, "2026-06-01"), 0);
// hireDate null → นับตั้งแต่ ม.ค. ตาม asOf
eq("hireDate null ณ มิ.ย. → 6 เดือน", traditionalHolidayAccruedDays(null, 2026, "2026-06-15"), Math.round(6 * PM * 100) / 100);
// asOf ปีถัดไป → เต็มปี 13
eq("asOf ปีถัดไป → 13", traditionalHolidayAccruedDays("2024-01-01", 2026, "2027-02-01"), 13);
// เข้าเดือน ส.ค. แต่ถามตอน มี.ค. (ยังไม่เข้า) → 0
eq("hired ส.ค. ถามตอน มี.ค. → 0", traditionalHolidayAccruedDays("2026-08-01", 2026, "2026-03-10"), 0);

console.log(fails === 0 ? "\nALL HOLIDAY-ACCRUAL FIXTURES PASSED" : `\n${fails} FAILED`);
if (fails > 0) process.exit(1);
