// Fixture: break-even fixed/variable-by-is_fixed (owner 2026-07-21). Validates
// the one-time seed (preserves the old category-code classification) and the new
// costsInRange grouping (fixed/variable by is_fixed; CP/LN excluded). Self-
// contained in-memory DB — getDb() can't bootstrap a fresh file in this env.
// Run:  node --import tsx scripts/verify-be-fixed.ts
import Database from "better-sqlite3";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE accounta_categories (id INTEGER PRIMARY KEY, code TEXT, name TEXT);
  CREATE TABLE accounta_expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id INTEGER, category TEXT,
    amount_total REAL, review_status TEXT DEFAULT 'confirmed',
    capex_bucket TEXT, is_fixed INTEGER NOT NULL DEFAULT 0
  );
`);
// Seed categories (code → name), mirroring db.ts.
const cats: Array<[string, string]> = [
  ["RT", "ค่าเช่า"], ["LB", "ค่าแรง/เงินเดือน/ประกันสังคม"], ["GD", "สินค้า/เวชภัณฑ์"],
  ["FC", "ค่าธรรมเนียมการเงิน/แพลตฟอร์ม"], ["CP", "รายจ่ายลงทุน/ครุภัณฑ์ (CapEx)"],
  ["LN", "ชำระเงินกู้"], ["MK", "การตลาด/โฆษณา"]
];
for (const [code, name] of cats) db.prepare("INSERT INTO accounta_categories (code,name) VALUES (?,?)").run(code, name);

// Existing rows (is_fixed defaults 0, as if pre-migration). branch 1.
const ins = db.prepare("INSERT INTO accounta_expenses (branch_id, category, amount_total, capex_bucket) VALUES (?,?,?,?)");
ins.run(1, "ค่าเช่า", 50000, null);                       // RT → should seed fixed
ins.run(1, "ค่าแรง/เงินเดือน/ประกันสังคม", 40000, null);   // LB → fixed
ins.run(1, "การตลาด/โฆษณา", 10000, null);                 // MK → fixed
ins.run(1, "สินค้า/เวชภัณฑ์", 200000, null);               // GD → variable (stays 0)
ins.run(1, "ค่าธรรมเนียมการเงิน/แพลตฟอร์ม", 15000, null);   // FC → variable (stays 0)
ins.run(1, "รายจ่ายลงทุน/ครุภัณฑ์ (CapEx)", 300000, "ffe"); // CP + capex → excluded, stays 0
ins.run(1, "ชำระเงินกู้", 25000, null);                     // LN → excluded, stays 0
ins.run(1, "ค่าอื่นๆ ไม่มีในหมวด", 5000, null);            // free-text → fixed (unknown = fixed)

// ── The seed migration (mirrors db.ts) ──────────────────────────
db.exec(`
  UPDATE accounta_expenses
     SET is_fixed = 1
   WHERE capex_bucket IS NULL
     AND COALESCE(category,'') NOT IN (
       SELECT name FROM accounta_categories WHERE code IN ('GD','FC','CP','LN')
     )
`);

const fixedOf = (cat: string) =>
  (db.prepare("SELECT is_fixed FROM accounta_expenses WHERE category = ?").get(cat) as { is_fixed: number }).is_fixed;
assert(fixedOf("ค่าเช่า") === 1, "seed: ค่าเช่า (RT) → fixed");
assert(fixedOf("ค่าแรง/เงินเดือน/ประกันสังคม") === 1, "seed: เงินเดือน (LB) → fixed");
assert(fixedOf("การตลาด/โฆษณา") === 1, "seed: การตลาด (MK) → fixed");
assert(fixedOf("ค่าอื่นๆ ไม่มีในหมวด") === 1, "seed: free-text/unknown → fixed");
assert(fixedOf("สินค้า/เวชภัณฑ์") === 0, "seed: สินค้า (GD) → variable");
assert(fixedOf("ค่าธรรมเนียมการเงิน/แพลตฟอร์ม") === 0, "seed: ค่าธรรมเนียม (FC) → variable");
assert(fixedOf("ชำระเงินกู้") === 0, "seed: เงินกู้ (LN) stays 0 (excluded anyway)");

// ── costsInRange grouping (mirrors accounta-db.ts) ──────────────
const BE_EXCLUDED = new Set(["CP", "LN"]);
const nameToCode = new Map(
  (db.prepare("SELECT code, name FROM accounta_categories").all() as Array<{ code: string; name: string }>)
    .map((c) => [c.name, c.code])
);
const rows = db.prepare(
  `SELECT COALESCE(category,'') AS cat, is_fixed AS isFixed, COALESCE(SUM(amount_total),0) AS amt
     FROM accounta_expenses
    WHERE review_status = 'confirmed' AND branch_id = 1 AND capex_bucket IS NULL
    GROUP BY COALESCE(category,''), is_fixed`
).all() as Array<{ cat: string; isFixed: number; amt: number }>;
let fixed = 0, variable = 0;
for (const r of rows) {
  const code = nameToCode.get(r.cat) ?? null;
  if (code && BE_EXCLUDED.has(code as string)) continue;   // CP already filtered by capex; LN here
  if (r.isFixed) fixed += r.amt; else variable += r.amt;
}
// fixed = 50000+40000+10000+5000 = 105000 ; variable = 200000+15000 = 215000 ; LN (25000) excluded
assert(fixed === 105000, `fixed total = 105,000 (got ${fixed})`);
assert(variable === 215000, `variable total = 215,000 (got ${variable})`);

// ── new defaults ────────────────────────────────────────────────
const manualDefault = (isFixedInput?: boolean) => (isFixedInput ? 1 : 0);   // createExpense: default variable
const recurringDefault = (isFixedInput?: boolean) => (isFixedInput !== false ? 1 : 0); // template: default fixed
assert(manualDefault(undefined) === 0, "manual expense default = variable");
assert(manualDefault(true) === 1, "manual expense marked fixed = fixed");
assert(recurringDefault(undefined) === 1, "recurring template default = fixed");
assert(recurringDefault(false) === 0, "recurring template can be set variable");

console.log("\nALL BE-FIXED FIXTURES PASSED");
