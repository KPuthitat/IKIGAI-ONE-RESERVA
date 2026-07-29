// Fixture (owner 2026-07-29): cross-company helper must NOT have ประกันสังคม
// withheld at a company that isn't their สังกัด (พรนภา สังกัด AT HOME ไปช่วย
// NAMA/EMIA). Validates the EXACT homeCompanyExpr SQL from computePayrollPeriod
// against a self-contained in-memory DB — including NULL-safety and the
// same-company multi-branch case (NAMA+HYPO under one company must stay =1).
//   node --import tsx scripts/verify-cross-company-sso.ts
import Database from "better-sqlite3";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE companies (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE branches (id INTEGER PRIMARY KEY, name TEXT, company_id INTEGER);
  CREATE TABLE user_branches (user_id INTEGER, branch_id INTEGER, is_primary INTEGER DEFAULT 0);
`);
// Companies: 1 = AT HOME (พรนภา สังกัด), 2 = NAMA co (NAMA + HYPO), 3 = EMIA co
db.prepare("INSERT INTO companies (id,name) VALUES (1,'AT HOME'),(2,'NAMA CO'),(3,'EMIA CO')").run();
// Branches: 10 AT HOME | 20 NAMA, 21 HYPO (same co 2) | 30 EMIA | 40 no-company
db.prepare(`INSERT INTO branches (id,name,company_id) VALUES
  (10,'AT HOME',1),(20,'NAMA',2),(21,'HYPO',2),(30,'EMIA',3),(40,'ORPHAN',NULL)`).run();
// Users:
//  1 พรนภา — home = AT HOME (branch 10, is_primary), linked to NAMA+EMIA too
//  2 นภดล — home = NAMA (branch 20), also works HYPO (21) — same company
//  3 ไร้สาขาหลัก — only lowest-branch fallback (no is_primary flag)
//  4 home at ORPHAN (NULL company)
db.prepare("INSERT INTO user_branches VALUES (1,10,1),(1,20,0),(1,30,0)").run();
db.prepare("INSERT INTO user_branches VALUES (2,20,1),(2,21,0)").run();
db.prepare("INSERT INTO user_branches VALUES (3,20,0),(3,30,0)").run(); // no primary → MIN=20 (co 2)
db.prepare("INSERT INTO user_branches VALUES (4,40,1),(4,20,0)").run();

// EXACT expression from computePayrollPeriod (branch-set path). @pcompany is the
// period branch's company_id (looked up in JS); users.id is bound per-row here.
const HOME_EXPR = `
  CASE WHEN (SELECT b.company_id FROM branches b WHERE b.id = COALESCE(
         (SELECT ub.branch_id FROM user_branches ub WHERE ub.user_id = @uid AND ub.is_primary = 1 LIMIT 1),
         (SELECT MIN(ub.branch_id) FROM user_branches ub WHERE ub.user_id = @uid)
       )) IS @pcompany THEN 1
     WHEN (SELECT b.company_id FROM branches b WHERE b.id = COALESCE(
         (SELECT ub.branch_id FROM user_branches ub WHERE ub.user_id = @uid AND ub.is_primary = 1 LIMIT 1),
         (SELECT MIN(ub.branch_id) FROM user_branches ub WHERE ub.user_id = @uid)
       )) IS NULL THEN 1
     ELSE 0 END AS h`;
const companyOf = db.prepare("SELECT company_id AS c FROM branches WHERE id = ?");
const flag = (uid: number, periodBranch: number): number => {
  const pc = (companyOf.get(periodBranch) as { c: number | null } | undefined)?.c ?? null;
  // Mirror computePayrollPeriod's guard: the CASE runs only when the period
  // branch's company is known; unknown → constant 1 (never guess cross-company).
  if (pc == null) return 1;
  return (db.prepare(`SELECT ${HOME_EXPR}`).get({ uid, pcompany: pc }) as { h: number }).h;
};

// พรนภา (home AT HOME / co 1)
assert(flag(1, 10) === 1, "พรนภา ที่สาขาต้นสังกัด (AT HOME) → 1 (หัก SSO)");
assert(flag(1, 20) === 0, "พรนภา ที่ NAMA (คนละบริษัท) → 0 (ไม่หัก SSO)");
assert(flag(1, 30) === 0, "พรนภา ที่ EMIA (คนละบริษัท) → 0 (ไม่หัก SSO)");

// นภดล (home NAMA / co 2) — same-company multi-branch must stay 1
assert(flag(2, 20) === 1, "นภดล ที่ NAMA (สาขาหลัก) → 1");
assert(flag(2, 21) === 1, "นภดล ที่ HYPO (บริษัทเดียวกัน) → 1 (SSO ยังหัก — regression guard)");

// no is_primary → MIN(branch)=20 (co 2)
assert(flag(3, 20) === 1, "ไม่มีสาขาหลัก: ที่ MIN-branch (บริษัทเดียวกัน) → 1");
assert(flag(3, 30) === 0, "ไม่มีสาขาหลัก: ที่ EMIA (คนละบริษัท) → 0");

// fail-safe: home branch has NULL company_id → always 1 (never wrongly drop SSO)
assert(flag(4, 20) === 1, "home บริษัท NULL: ที่ NAMA → 1 (fail-safe)");
assert(flag(4, 40) === 1, "home บริษัท NULL: ที่สาขาตัวเอง → 1");

// period branch itself has NULL company (orphan) for a known-company home → 1
assert(flag(2, 40) === 1, "สาขาปลายทางบริษัท NULL → 1 (fail-safe, ไม่ตัดสินว่าข้ามบริษัท)");

console.log("\nAll cross-company SSO gate checks passed.");
