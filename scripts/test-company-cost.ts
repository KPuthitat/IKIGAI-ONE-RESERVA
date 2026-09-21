// companyCostStructure — "กฎ 100%" cost ratios per branch + company (owner 2026-09-21).
// Sales = 100%; each cost bucket (COG/GD, ค่าแรง/LB, ค่าธรรมเนียม/FC, อื่นๆ) as % of
// sales; net profit %. COG% flagged vs the branch's %COG ceiling. CapEx/loan excluded.
//
// Run:  node --import tsx scripts/test-company-cost.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-company-cost.db");
function cleanup() {
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
}
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const { companyCostStructure } = await import("../src/lib/accounta-db");
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (name: string, cond: boolean) => {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ FAIL: ${name}`); }
  };
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

  const co = Number(db.prepare("INSERT INTO companies (name_th) VALUES ('บริษัททดสอบ')").run().lastInsertRowid);
  // Branch A: %COG ceiling 35 enabled. Branch B: no quota.
  const A = Number(db.prepare("INSERT INTO branches (slug,name,company_id,display_order,material_quota_enabled,material_budget_pct) VALUES ('a','CO-A',?,1,1,35)").run(co).lastInsertRowid);
  // B has a stored ceiling value but quota disabled → must NOT be flagged.
  const B = Number(db.prepare("INSERT INTO branches (slug,name,company_id,display_order,material_quota_enabled,material_budget_pct) VALUES ('b','CO-B',?,2,0,40)").run(co).lastInsertRowid);

  // Resolve category names by code (use seeded ones if present, else create).
  const catName = (code: string, fallback: string): string => {
    const r = db.prepare("SELECT name FROM accounta_categories WHERE code = ? AND active = 1").get(code) as { name: string } | undefined;
    if (r) return r.name;
    db.prepare("INSERT INTO accounta_categories (code,name,active) VALUES (?,?,1)").run(code, fallback);
    return fallback;
  };
  const GD = catName("GD", "วัตถุดิบ"), LB = catName("LB", "เงินเดือน"), FC = catName("FC", "GP"), CP = catName("CP", "ลงทุน");

  // Sales via branch_daily_revenue (branchSalesForRange merges income + this).
  const sale = (bid: number, d: string, amt: number) => db.prepare("INSERT INTO branch_daily_revenue (branch_id,date,revenue) VALUES (?,?,?)").run(bid, d, amt);
  sale(A, "2026-09-10", 100000);
  sale(B, "2026-09-10", 50000);

  const exp = (bid: number, cat: string, amt: number) => db.prepare(
    "INSERT INTO accounta_expenses (branch_id,company_id,bill_date,category,amount_total,review_status) VALUES (?,?,?,?,?,'confirmed')"
  ).run(bid, co, "2026-09-15", cat, amt);
  // A: COG 40% (> ceiling 35), labor 20%, fees 5%, other rent 10%, plus CapEx (excluded).
  exp(A, GD, 40000); exp(A, LB, 20000); exp(A, FC, 5000); exp(A, "ค่าเช่า", 10000); exp(A, CP, 99999);
  // B: COG 20%, labor 16%.
  exp(B, GD, 10000); exp(B, LB, 8000);
  // Company-level bill booked to NO branch (branch_id IS NULL) — e.g. accountant fee.
  // Must roll into the company total (otherOpex) but into no branch row.
  db.prepare(
    "INSERT INTO accounta_expenses (branch_id,company_id,bill_date,category,amount_total,review_status) VALUES (NULL,?,?,?,?,'confirmed')"
  ).run(co, "2026-09-15", "ค่าทำบัญชี", 3000);

  // today after month end → month is complete → COG-over-ceiling flag is decided.
  const cost = companyCostStructure(co, "2026-09", "2026-10-01");
  const a = cost.branches.find((x) => x.branchId === A)!;
  const b = cost.branches.find((x) => x.branchId === B)!;

  ok("A sales 100000, COG 40000 (40%), ceiling 35, over → true", a.sales === 100000 && a.cog === 40000 && near(a.cogPct!, 40) && a.cogCeilingPct === 35 && a.cogOverCeiling === true);
  ok("A labor 20%, fees 5%, other 10% (CapEx excluded)", near(a.laborPct!, 20) && near(a.feesPct!, 5) && a.otherOpex === 10000 && near(a.otherPct!, 10));
  ok("A net profit = 25000 (25%)", a.netProfit === 25000 && near(a.netPct!, 25));
  ok("B COG 20%, no ceiling → not flagged", b.sales === 50000 && near(b.cogPct!, 20) && b.cogCeilingPct === null && b.cogOverCeiling === false);
  ok("B net = 32000 (64%)", b.netProfit === 32000 && near(b.netPct!, 64));
  // Company total includes the NULL-branch accountant fee (3000, other opex):
  // sales 150000, COG 50000 (33.33%), otherOpex = A 10000 + null 3000 = 13000, net 54000.
  ok("company total: sales 150000, COG 50000 (33.33%), net 54000 (incl NULL-branch bill)", cost.total.sales === 150000 && cost.total.cog === 50000 && near(cost.total.cogPct!, 33.33) && cost.total.otherOpex === 13000 && cost.total.netProfit === 54000);
  ok("NULL-branch bill is in the total only, not attributed to any branch row", a.otherOpex === 10000 && b.otherOpex === 0);
  ok("branches ordered A before B (display_order)", cost.branches[0].branchId === A && cost.branches[1].branchId === B);

  // Mid-month (today inside the month) → COG-over-ceiling flag is deferred (not decided yet).
  const midMonth = companyCostStructure(co, "2026-09", "2026-09-15");
  const aMid = midMonth.branches.find((x) => x.branchId === A)!;
  ok("mid-month: COG% still shown (40%) but over-ceiling flag deferred → false", near(aMid.cogPct!, 40) && aMid.cogCeilingPct === 35 && aMid.cogOverCeiling === false);

  console.log(`\ncompany-cost test: ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
