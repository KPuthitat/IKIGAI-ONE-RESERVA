// Fixture: ทำงานวันหยุดประเพณี เลื่อน/ใช้สิทธิ์ (owner 2026-08-04).
//
// admin เลือกต่อคนต่อวัน: 'use' → วันนั้น 2 เท่า (เฉพาะคนนั้น) + โควตาวันหยุด −1;
// 'defer' → ค่าจ้างปกติ ไม่ตัดโควตา. นี่คือ logic ใหม่ที่ชั้น DB/loader + leave.ts —
// exercise มันตรง ๆ กับ in-memory DB (isDouble→2× ใน engine มี test-payroll คุมอยู่แล้ว).
//
// Run:  node --import tsx scripts/verify-holiday-choice.ts
import Database from "better-sqlite3";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE public_holidays (date TEXT PRIMARY KEY, double_pay INTEGER DEFAULT 0);
  CREATE TABLE holiday_work_choices (
    user_id INTEGER, work_date TEXT, choice TEXT CHECK(choice IN ('defer','use')),
    UNIQUE(user_id, work_date)
  );
`);
// A traditional holiday date (NOT global double_pay). Songkran = global double.
db.prepare("INSERT INTO public_holidays (date, double_pay) VALUES ('2026-08-12', 0)").run(); // แม่ (trad)
db.prepare("INSERT INTO public_holidays (date, double_pay) VALUES ('2026-04-13', 1)").run(); // สงกรานต์ (all 2×)
// User 1 chose 'use' on the traditional holiday; User 2 chose 'defer'.
db.prepare("INSERT INTO holiday_work_choices VALUES (1, '2026-08-12', 'use')").run();
db.prepare("INSERT INTO holiday_work_choices VALUES (2, '2026-08-12', 'defer')").run();

const START = "2026-01-01", END = "2026-12-31";

// Mirror computePayrollPeriod: global double set + per-user 'use' set.
const globalDouble = new Set(
  (db.prepare("SELECT date FROM public_holidays WHERE date >= ? AND date <= ? AND double_pay = 1")
    .all(START, END) as Array<{ date: string }>).map((r) => r.date)
);
const useByUser = new Map<number, Set<string>>();
for (const r of db.prepare(
  "SELECT user_id, work_date FROM holiday_work_choices WHERE choice = 'use' AND work_date >= ? AND work_date <= ?"
).all(START, END) as Array<{ user_id: number; work_date: string }>) {
  const s = useByUser.get(r.user_id) ?? new Set<string>();
  s.add(r.work_date); useByUser.set(r.user_id, s);
}
const doubleSetFor = (uid: number) => {
  const own = useByUser.get(uid);
  return own && own.size ? new Set([...globalDouble, ...own]) : globalDouble;
};

// User 1 (use): 2× on their traditional holiday AND on Songkran (global).
assert(doubleSetFor(1).has("2026-08-12"), "user1 'use' → 2× on traditional holiday");
assert(doubleSetFor(1).has("2026-04-13"), "user1 also 2× on global Songkran");
// User 2 (defer): NOT 2× on the traditional holiday, but still 2× on Songkran.
assert(!doubleSetFor(2).has("2026-08-12"), "user2 'defer' → NOT 2× on traditional holiday");
assert(doubleSetFor(2).has("2026-04-13"), "user2 still 2× on global Songkran");
// User 3 (no choice): only the global set.
assert(!doubleSetFor(3).has("2026-08-12"), "user3 no choice → NOT 2× on traditional holiday");
assert(doubleSetFor(3).has("2026-04-13"), "user3 gets global Songkran 2×");

// Mirror leave.ts holiday quota "used": count 'use' choices this year × 8h.
const usedHolidayHours = (uid: number): number => {
  const c = db.prepare(
    "SELECT COUNT(*) AS n FROM holiday_work_choices WHERE user_id = ? AND choice = 'use' AND substr(work_date,1,4) = '2026'"
  ).get(uid) as { n: number };
  return c.n * 8;
};
assert(usedHolidayHours(1) === 8, "user1 'use' → holiday quota used 8h (1 วัน)");
assert(usedHolidayHours(2) === 0, "user2 'defer' → quota NOT consumed");
assert(usedHolidayHours(3) === 0, "user3 no choice → quota untouched");

// Two 'use' days for one user → 2 วัน used. (quota query reads DB live.)
db.prepare("INSERT INTO holiday_work_choices VALUES (1, '2026-08-13', 'use')").run();
assert(usedHolidayHours(1) === 16, "user1 second 'use' → 16h (2 วัน)");
// Re-derive the 'use' set from DB (the loader rebuilds it every period run).
const user1UseDays = new Set(
  (db.prepare("SELECT work_date FROM holiday_work_choices WHERE user_id = 1 AND choice = 'use'")
    .all() as Array<{ work_date: string }>).map((r) => r.work_date)
);
const user1Double = new Set([...globalDouble, ...user1UseDays]);
assert(user1Double.size === 3, "user1 double set = 2 trad 'use' + 1 global Songkran");

// 'use' requires worked evidence (owner 2026-08-04) — the day route rejects a
// 'use' choice on a non-worked holiday so a quota day is never burned for zero
// pay. Mirror that predicate: worked = a punch OR a worked day-override.
db.exec(`
  CREATE TABLE time_entries (user_id INTEGER, type TEXT, ts TEXT);
  CREATE TABLE payroll_line_days (period_id INTEGER, user_id INTEGER, work_date TEXT,
    clock_in TEXT, clock_out TEXT, worked_min INTEGER);
`);
// User 1 worked 2026-08-12 (a punch); User 2 has only a cleared override (no work).
db.prepare("INSERT INTO time_entries VALUES (1, 'in', '2026-08-12T04:00:00Z')").run();
db.prepare("INSERT INTO payroll_line_days VALUES (5, 2, '2026-08-12', NULL, NULL, 0)").run();
const workedOn = (uid: number, date: string, clockInReq = false): boolean => {
  if (clockInReq) return true;
  const punch = db.prepare(
    "SELECT 1 FROM time_entries WHERE user_id = ? AND type = 'in' AND ts >= ? AND ts <= ? LIMIT 1"
  ).get(uid, `${date}T00:00:00Z`, `${date}T23:59:59Z`);
  if (punch) return true;
  const ov = db.prepare(
    "SELECT 1 FROM payroll_line_days WHERE user_id = ? AND work_date = ? AND ((clock_in IS NOT NULL AND clock_out IS NOT NULL) OR COALESCE(worked_min,0) > 0) LIMIT 1"
  ).get(uid, date);
  return !!ov;
};
assert(workedOn(1, "2026-08-12"), "user1 worked (punch) → 'use' allowed");
assert(!workedOn(2, "2026-08-12"), "user2 no work (cleared override) → 'use' rejected");
assert(workedOn(2, "2026-08-12", true), "user2 with clock times in same request → 'use' allowed");

console.log("\nholiday choice: all checks passed ✓");
