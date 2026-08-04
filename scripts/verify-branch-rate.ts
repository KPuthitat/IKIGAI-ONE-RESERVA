// Fixture: per-branch PT rate resolution (owner 2026-08-04).
//
// A staffer who works several branches can earn a different hourly rate at each
// (พรนภา). branchHourlyRateSelect() builds the SQL that resolves the effective
// rate for a period's branch: user_branches.hourly_rate if set, else the
// employee's default users.hourly_rate. This exercises that exact fragment
// against an in-memory DB.
//
// Run:  node --import tsx scripts/verify-branch-rate.ts
import Database from "better-sqlite3";
import { branchHourlyRateSelect } from "../src/lib/payroll-compute";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, hourly_rate REAL);
  CREATE TABLE user_branches (user_id INTEGER, branch_id INTEGER, hourly_rate REAL,
    UNIQUE(user_id, branch_id));
`);
// พรนภา (id 1): default 300; NAMA(10)=350, HYPO(20)=400, SRI(30)=row-but-null.
db.prepare("INSERT INTO users (id, hourly_rate) VALUES (1, 300)").run();
db.prepare("INSERT INTO users (id, hourly_rate) VALUES (2, NULL)").run(); // no default rate
db.prepare("INSERT INTO user_branches (user_id, branch_id, hourly_rate) VALUES (1, 10, 350)").run();
db.prepare("INSERT INTO user_branches (user_id, branch_id, hourly_rate) VALUES (1, 20, 400)").run();
db.prepare("INSERT INTO user_branches (user_id, branch_id, hourly_rate) VALUES (1, 30, NULL)").run();
db.prepare("INSERT INTO user_branches (user_id, branch_id, hourly_rate) VALUES (2, 10, 250)").run();

const rateAt = (userId: number, branchId: number | null): number | null => {
  const row = db.prepare(
    `SELECT ${branchHourlyRateSelect(branchId)} FROM users WHERE id = ?`
  ).get(userId) as { hourly_rate: number | null };
  return row.hourly_rate;
};

assert(rateAt(1, 10) === 350, "branch NAMA rate set → 350");
assert(rateAt(1, 20) === 400, "branch HYPO rate set → 400");
assert(rateAt(1, 30) === 300, "branch SRI row exists but rate NULL → default 300");
assert(rateAt(1, 99) === 300, "branch with no user_branches row → default 300");
assert(rateAt(1, null) === 300, "company-wide period (branch null) → default 300");
// Rate must not leak across branches: querying NAMA never returns HYPO's 400.
assert(rateAt(1, 10) !== 400, "NAMA query does not pick up HYPO's rate");
// Employee with no default rate: branch override still applies; no branch → NULL.
assert(rateAt(2, 10) === 250, "no-default employee, branch rate set → 250");
assert(rateAt(2, 99) === null, "no-default employee, no branch rate → NULL (falls to pt_default at compute)");

console.log("\nper-branch rate: all checks passed ✓");
