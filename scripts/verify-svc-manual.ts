// Fixture: manual (pre-system) SVC — validate the exact SQL (roster query with
// the "OR already-allocated" clause + upsert) and the WHT math against a
// self-contained in-memory DB (getDb() can't bootstrap a fresh file in this env
// due to a pre-existing migration-order issue). Run:
//   node --import tsx scripts/verify-svc-manual.ts
import Database from "better-sqlite3";
import { isManualSvcMonth, SVC_SYSTEM_START_MONTH } from "../src/lib/service-charge";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

// ── month gate ──────────────────────────────────────────────────
assert(SVC_SYSTEM_START_MONTH === "2026-06", "system start = 2026-06");
assert(isManualSvcMonth("2026-01"), "2026-01 manual");
assert(isManualSvcMonth("2026-05"), "2026-05 manual");
assert(!isManualSvcMonth("2026-06"), "2026-06 NOT manual");
assert(!isManualSvcMonth("2026-07"), "2026-07 NOT manual");

// ── in-memory schema (only the tables the manual path touches) ──
const db = new Database(":memory:");
db.exec(`
  CREATE TABLE branches (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE users (
    id INTEGER PRIMARY KEY, display_name TEXT, role TEXT, employment_type TEXT,
    shift_start_time TEXT, weekly_off_days TEXT, track_attendance INTEGER DEFAULT 1,
    salary_tax_mode TEXT, title_prefix TEXT, employee_code TEXT,
    receives_service_charge INTEGER DEFAULT 1, is_test_account INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active', hire_date TEXT
  );
  CREATE TABLE user_branches (user_id INTEGER, branch_id INTEGER);
  CREATE TABLE svc_manual_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id INTEGER, year_month TEXT,
    user_id INTEGER, gross_amount REAL DEFAULT 0,
    entered_by_user_id INTEGER, entered_at TEXT,
    updated_by_user_id INTEGER, updated_at TEXT,
    UNIQUE(branch_id, year_month, user_id)
  );
`);
db.prepare("INSERT INTO branches (id,name) VALUES (1,'TEST')").run();
const u = db.prepare(`INSERT INTO users
  (id,display_name,role,employment_type,salary_tax_mode,receives_service_charge,is_test_account,status,employee_code,hire_date)
  VALUES (?,?,?,?,?,?,?,?,?,?)`);
u.run(10, "SSO", "staff", "ft", "sso", 1, 0, "active", "E10", null);
u.run(11, "WHT", "staff", "pt", "wht", 1, 0, "active", "E11", null);
u.run(12, "ZERO", "staff", "ft", "sso", 1, 0, "active", "E12", null);
u.run(13, "OPTOUT", "staff", "ft", "sso", 0, 0, "active", "E13", null); // ไม่รับ SVC
u.run(14, "RESIGNED", "staff", "pt", "wht", 1, 0, "resigned", "E14", null); // ลาออกแล้ว
for (const id of [10, 11, 12, 13, 14]) db.prepare("INSERT INTO user_branches VALUES (?,1)").run(id);

// ── upsert SQL (mirrors saveManualAllocations) ──────────────────
const up = db.prepare(`
  INSERT INTO svc_manual_allocations
    (branch_id, year_month, user_id, gross_amount, entered_by_user_id, entered_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(branch_id, year_month, user_id) DO UPDATE SET
    gross_amount = excluded.gross_amount, updated_by_user_id = ?, updated_at = ?`);
up.run(1, "2026-05", 10, 10000, 1, "t1", 1, "t1");
up.run(1, "2026-05", 11, 20000, 1, "t1", 1, "t1");
up.run(1, "2026-05", 14, 5000, 1, "t1", 1, "t1"); // resigned staff has a historical amount

// re-save overwrites, not duplicates
up.run(1, "2026-05", 10, 15000, 1, "t1", 1, "t2");
const cnt = db.prepare("SELECT COUNT(*) c FROM svc_manual_allocations WHERE user_id=10").get() as { c: number };
assert(cnt.c === 1, "upsert overwrites (no duplicate row for user 10)");
const g10 = db.prepare("SELECT gross_amount g FROM svc_manual_allocations WHERE user_id=10").get() as { g: number };
assert(g10.g === 15000, "upsert set gross to 15000");

// ── roster query (mirrors computeManualSvcSummary) ──────────────
const staff = db.prepare(`
  SELECT u.id AS userId, u.salary_tax_mode AS taxMode
  FROM users u
  JOIN user_branches ub ON ub.user_id = u.id
  WHERE ub.branch_id = ? AND u.role IN ('staff','admin')
    AND u.is_test_account = 0
    AND (
      (u.receives_service_charge = 1
        AND u.status NOT IN ('disabled','resigned','terminated')
        AND (u.hire_date IS NULL OR u.hire_date <= ?))
      OR u.id IN (SELECT user_id FROM svc_manual_allocations WHERE branch_id = ? AND year_month = ?)
    )
  ORDER BY (u.employee_code IS NULL), u.employee_code COLLATE NOCASE ASC
`).all(1, "2026-05-31", 1, "2026-05") as Array<{ userId: number; taxMode: string }>;
const ids = staff.map((s) => s.userId).sort((a, b) => a - b);
assert(JSON.stringify(ids) === JSON.stringify([10, 11, 12, 14]),
  `roster = active SVC staff + resigned-with-allocation, excludes opt-out (got ${ids})`);
assert(!ids.includes(13), "opt-out staff (receives_service_charge=0) excluded");
assert(ids.includes(14), "resigned staff WITH a historical allocation still shows");

// ── WHT math (mirrors row build) ────────────────────────────────
const whtRate = 0.03;
const round2 = (n: number) => Math.round(n * 100) / 100;
const gross = new Map(
  (db.prepare("SELECT user_id, gross_amount FROM svc_manual_allocations WHERE branch_id=1 AND year_month='2026-05'")
    .all() as Array<{ user_id: number; gross_amount: number }>).map((r) => [r.user_id, r.gross_amount])
);
function net(userId: number, taxMode: string) {
  const g = round2(gross.get(userId) ?? 0);
  const wht = taxMode === "wht" ? round2(g * whtRate) : 0;
  return { g, wht, net: round2(g - wht) };
}
const a10 = net(10, "sso"); assert(a10.wht === 0 && a10.net === 15000, "sso: no WHT, net 15000");
const a11 = net(11, "wht"); assert(a11.wht === 600 && a11.net === 19400, "wht: 3%=600, net 19400");
const a12 = net(12, "sso"); assert(a12.g === 0 && a12.net === 0, "unset staff: gross/net 0");
const a14 = net(14, "wht"); assert(a14.wht === 150 && a14.net === 4850, "resigned wht: 3% of 5000 = 150, net 4850");

console.log("\nALL MANUAL-SVC FIXTURES PASSED");
