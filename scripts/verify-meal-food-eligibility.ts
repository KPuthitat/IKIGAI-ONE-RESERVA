// Fixture (owner 2026-07-30): สวัสดิการอาหารกลางวัน now needs BOTH the clock-in
// gate (eligible start + not too late) AND a rostered shift > 8h. The drink
// coupon keeps the looser clock-in-only gate. Also validates the scheduled-
// shift-minutes SQL (sum across assignments + overnight handling).
//   node --import tsx scripts/verify-meal-food-eligibility.ts
import Database from "better-sqlite3";
import {
  isEligibleClockIn, isFoodEligible, MEAL_FOOD_MIN_SHIFT_MINUTES, type MealCouponConfig
} from "../src/lib/meal-coupons";
import { timeToMinutes } from "../src/lib/time";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

const cfg: MealCouponConfig = {
  enabled: true, eligibleStarts: ["11:00", "12:00"], redeemCutoff: "15:00", graceMin: 15
};

// ── clock-in gate (unchanged, drink) ────────────────────────────────
assert(isEligibleClockIn(cfg, "11:00", timeToMinutes("11:05")), "11:00 กะ, เข้า 11:05 (ในเกรซ) → ผ่าน");
assert(!isEligibleClockIn(cfg, "11:00", timeToMinutes("11:30")), "11:00 กะ, เข้า 11:30 (เกินเกรซ) → ไม่ผ่าน");
assert(!isEligibleClockIn(cfg, "09:00", timeToMinutes("09:00")), "กะ 09:00 (ไม่อยู่ในรายการ) → ไม่ผ่าน");
assert(!isEligibleClockIn({ ...cfg, enabled: false }, "11:00", timeToMinutes("11:00")), "ปิดฟีเจอร์ → ไม่ผ่าน");
assert(!isEligibleClockIn(cfg, null, 600), "ไม่มีกะ → ไม่ผ่าน");

// ── food gate = clock-in gate AND shift > 8h (480 min) ──────────────
assert(MEAL_FOOD_MIN_SHIFT_MINUTES === 480, "เกณฑ์อาหาร = 480 นาที (8 ชม.)");
assert(isFoodEligible(cfg, "11:00", timeToMinutes("11:05"), 540), "เข้าเกณฑ์เวลา + กะ 9 ชม. → ได้อาหาร");
assert(!isFoodEligible(cfg, "11:00", timeToMinutes("11:05"), 480), "กะ 8 ชม. พอดี (ไม่เกิน) → ไม่ได้อาหาร");
assert(isFoodEligible(cfg, "11:00", timeToMinutes("11:05"), 481), "กะ 8 ชม. 1 นาที (เกิน) → ได้อาหาร");
assert(!isFoodEligible(cfg, "11:00", timeToMinutes("11:05"), 300), "กะสั้น 5 ชม. → ไม่ได้อาหาร");
assert(!isFoodEligible(cfg, "11:00", timeToMinutes("11:30"), 600), "กะยาวแต่เข้าสาย (ตกเกณฑ์เวลา) → ไม่ได้อาหาร");
assert(!isFoodEligible(cfg, "09:00", timeToMinutes("09:00"), 600), "กะยาวแต่เวลาเริ่มไม่เข้าเกณฑ์ → ไม่ได้อาหาร");

// ── scheduled-minutes SQL (mirrors scheduledShiftMinutesForUserDate) ─
const db = new Database(":memory:");
db.exec(`
  CREATE TABLE shift_codes (id INTEGER PRIMARY KEY, start_time TEXT, end_time TEXT);
  CREATE TABLE roster_assignments (user_id INTEGER, branch_id INTEGER, assignment_date TEXT, shift_code_id INTEGER);
`);
db.prepare("INSERT INTO shift_codes (id,start_time,end_time) VALUES (1,'11:00','20:00'),(2,'10:00','14:00'),(3,'22:00','06:00'),(4,NULL,NULL)").run();
const q = db.prepare(`
  SELECT s.start_time AS st, s.end_time AS et
  FROM roster_assignments a JOIN shift_codes s ON s.id = a.shift_code_id
  WHERE a.user_id = ? AND a.branch_id = ? AND a.assignment_date = ?
    AND s.start_time IS NOT NULL AND s.end_time IS NOT NULL
`);
const minutesFor = (uid: number): number => {
  let total = 0;
  for (const r of q.all(uid, 1, "2026-07-30") as Array<{ st: string; et: string }>) {
    const start = timeToMinutes(r.st), end = timeToMinutes(r.et);
    total += end > start ? end - start : end + 1440 - start;
  }
  return total;
};
db.prepare("INSERT INTO roster_assignments VALUES (10,1,'2026-07-30',1)").run(); // 11-20 = 540
db.prepare("INSERT INTO roster_assignments VALUES (11,1,'2026-07-30',2)").run(); // 10-14 = 240
db.prepare("INSERT INTO roster_assignments VALUES (12,1,'2026-07-30',3)").run(); // 22-06 overnight = 480
db.prepare("INSERT INTO roster_assignments VALUES (13,1,'2026-07-30',2)").run(); // split shift
db.prepare("INSERT INTO roster_assignments VALUES (13,1,'2026-07-30',1)").run(); // 240 + 540 = 780
db.prepare("INSERT INTO roster_assignments VALUES (14,1,'2026-07-30',4)").run(); // NULL times → skipped

assert(minutesFor(10) === 540, "กะเดียว 11:00-20:00 → 540 นาที");
assert(minutesFor(11) === 240, "กะเดียว 10:00-14:00 → 240 นาที");
assert(minutesFor(12) === 480, "กะข้ามคืน 22:00-06:00 → 480 นาที");
assert(minutesFor(13) === 780, "สองกะรวม (240+540) → 780 นาที");
assert(minutesFor(14) === 0, "กะไม่มีเวลาเริ่ม/จบ → 0 นาที (ข้าม)");
assert(minutesFor(99) === 0, "ไม่มีกะ → 0 นาที");

console.log("\nAll meal food-eligibility checks passed.");
