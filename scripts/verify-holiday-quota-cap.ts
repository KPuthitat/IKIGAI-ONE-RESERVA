// Fixture: วันหยุดประเพณี — เพดานตามสิทธิ์สะสม (owner 2026-08-04).
//
// ลาวันหยุดประเพณี (holiday) ได้ไม่เกินสิทธิ์ที่สะสม (13/ปี ~1.08/เดือน). "used"
// นับทั้งใบลา holiday (pending/approved) ปีนี้ + วันที่ "ใช้สิทธิ์" มาทำงานวันหยุด
// (holiday_work_choices choice='use') ที่ตัดโควตาไปแล้ว. คำขอที่ทำให้ used เกิน
// remaining → reject. mirror predicate ใน leave route + getLeaveHoursUsedThisYear.
//
// Run:  node --import tsx scripts/verify-holiday-quota-cap.ts
import Database from "better-sqlite3";
import { traditionalHolidayAccruedDays } from "../src/lib/leave";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE leave_requests (user_id INTEGER, type TEXT, date_from TEXT, days REAL, hours REAL, status TEXT);
  CREATE TABLE holiday_work_choices (user_id INTEGER, work_date TEXT, choice TEXT);
`);

const YEAR = 2026;
// Accrual as of end of year for someone hired before this year = full 13.
const accrued = traditionalHolidayAccruedDays(null, YEAR, `${YEAR}-12-31`);
assert(Math.abs(accrued - 13) < 1e-6, "hired-before-year → full 13 days accrued by year end");

// Mirror getLeaveHoursUsedThisYear('holiday'): leave_requests (pending/approved,
// this year) days + count(use choices this year); returned as hours (÷8 = days).
const usedDays = (uid: number): number => {
  const lr = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN hours IS NOT NULL THEN hours ELSE days*8 END),0) AS h
    FROM leave_requests WHERE user_id = ? AND type = 'holiday'
      AND status IN ('pending','approved') AND substr(date_from,1,4) = ?
  `).get(uid, String(YEAR)) as { h: number };
  const uc = db.prepare(
    "SELECT COUNT(*) AS n FROM holiday_work_choices WHERE user_id = ? AND choice = 'use' AND substr(work_date,1,4) = ?"
  ).get(uid, String(YEAR)) as { n: number };
  return (lr.h + uc.n * 8) / 8;
};
// The route's guard: reject when requestedDays > remaining (= accrued - used).
const wouldReject = (uid: number, requestedDays: number): boolean =>
  requestedDays > (accrued - usedDays(uid)) + 1e-6;

// User 1: 10 holiday-leave days used + 2 'ใช้สิทธิ์' worked-holiday days = 12 used.
db.prepare("INSERT INTO leave_requests VALUES (1,'holiday','2026-03-01',10,NULL,'approved')").run();
db.prepare("INSERT INTO holiday_work_choices VALUES (1,'2026-05-01','use')").run();
db.prepare("INSERT INTO holiday_work_choices VALUES (1,'2026-06-01','use')").run();
assert(Math.abs(usedDays(1) - 12) < 1e-6, "user1 used = 10 leave + 2 ใช้สิทธิ์ = 12");
assert(!wouldReject(1, 1), "user1 request 1 more (12+1=13 ≤ 13) → allowed");
assert(wouldReject(1, 2), "user1 request 2 more (12+2=14 > 13) → rejected");

// User 2: nothing used → can take up to 13.
assert(!wouldReject(2, 13), "user2 request 13 (0 used) → allowed");
assert(wouldReject(2, 14), "user2 request 14 → rejected");

// 'defer' choices do NOT consume quota (they didn't use the holiday right).
db.prepare("INSERT INTO holiday_work_choices VALUES (3,'2026-04-01','defer')").run();
assert(usedDays(3) === 0, "user3 'defer' → quota not consumed");
assert(!wouldReject(3, 13), "user3 can still take full 13 despite a defer");

// ── Year selection (mirror holidayQuotaRemainingForLeave's asOf rule) ──────
// A leave in a COMPLETED year is measured at that year's Dec 31 (fully accrued);
// a current-year leave at "today". This is Finding A: a cross-year backdated
// holiday must draw on ITS year, not always the current year.
const accruedForLeave = (hireDate: string | null, leaveYear: number, nowYear: number, nowBkk: string) => {
  const asOf = leaveYear === nowYear ? nowBkk : `${leaveYear}-12-31`;
  return traditionalHolidayAccruedDays(hireDate, leaveYear, asOf);
};
// Filed in 2026 for a 2025 date → 2025 is complete → full 13 (hired before 2025).
assert(Math.abs(accruedForLeave("2024-01-01", 2025, 2026, "2026-03-10") - 13) < 1e-6,
  "backdated 2025 leave (filed 2026) → measured against full 2025 quota (13)");
// Same person's 2026 leave as of mid-March → partial accrual (~3.25), not 13.
const midCur = accruedForLeave("2024-01-01", 2026, 2026, "2026-03-10");
assert(midCur > 3 && midCur < 4, `current-year 2026 leave as of Mar → ~3.25 accrued (got ${midCur})`);
// Hired mid-2025: a 2025 leave uses 2025's prorated accrual (Jul→Dec ≈ 6.5), not 2026's.
const hiredMid = accruedForLeave("2025-07-01", 2025, 2026, "2026-03-10");
assert(hiredMid > 6 && hiredMid < 7, `hired Jul 2025, 2025 leave → ~6.5 accrued for 2025 (got ${hiredMid})`);

console.log("\nholiday quota cap: all checks passed ✓");
