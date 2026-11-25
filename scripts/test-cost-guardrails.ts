// Restaurant cost bands: migration of the benchmark defaults, ratios net of partner payout and CapEx, alerts, band edits.
// Run: node --import tsx scripts/test-cost-guardrails.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-cost-guardrails.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const C = await import("../src/lib/cost-guardrails");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const band = (code: string) => db.prepare("SELECT target_pct_min mn, target_pct_max mx FROM accounta_categories WHERE code = ?").get(code) as { mn: number; mx: number };
  const cat = (code: string) => (db.prepare("SELECT name FROM accounta_categories WHERE code = ?").get(code) as { name: string }).name;

  ok("bands follow the owner's table", JSON.stringify([band("GD"), band("LB"), band("RT"), band("UT"), band("AO"), band("MK")]) === JSON.stringify([{ mn: 30, mx: 35 }, { mn: 15, mx: 20 }, { mn: 15, mx: 20 }, { mn: 1, mx: 5 }, { mn: 1, mx: 5 }, { mn: 2, mx: 5 }]));

  const br = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('nama','NAMA')").run().lastInsertRowid);
  const inc = (amt: number) => db.prepare("INSERT INTO accounta_income (branch_id, income_date, channel, amount) VALUES (?,?,?,?)").run(br, "2026-11-10", "เงินสด", amt);
  const exp = (code: string, amt: number) => db.prepare("INSERT INTO accounta_expenses (branch_id, bill_date, category, amount_total, base_amount, review_status) VALUES (?,?,?,?,?,'confirmed')").run(br, "2026-11-10", cat(code), amt, amt);
  inc(1_000_000);
  exp("GD", 380_000);
  exp("LB", 180_000); exp("RT", 100_000); exp("PR", 50_000); exp("CP", 300_000);

  const r = C.buildCostRatios("2026-11", br);
  ok("revenue is net of the partner payout", r.revenueBooks === 1_000_000 && r.partnerPayout === 50_000 && r.revenue === 950_000);
  ok("CapEx and the payout are not costs", !r.rows.some((x) => x.code === "CP" || x.code === "PR") && r.costTotal === 660_000);
  const gd = r.rows.find((x) => x.code === "GD")!;
  ok("COGS 380k / 950k = 40% → over its 30–35 band", gd.pct === 40 && gd.status === "over");
  ok("labor 18.95% is inside 15–20", r.rows.find((x) => x.code === "LB")!.status === "ok");
  ok("profit = revenue − costs, as % of net revenue", r.profit === 290_000 && r.profitPct === 30.53 && r.profitStatus === "over");
  ok("alerts list only cost lines over band (profit above band is not an alert)", C.costAlerts(r).length === 1 && C.costAlerts(r)[0].startsWith(cat("GD")));
  exp("MI", 600_000);
  const r2 = C.buildCostRatios("2026-11", br);
  ok("profit under its band is alerted", r2.profitStatus === "under" && C.costAlerts(r2).some((a) => a.startsWith("กำไรก่อนภาษี")));

  ok("a band can be edited", C.setBand("LB", 12, 18) && band("LB").mn === 12 && band("LB").mx === 18);
  ok("a reversed or out-of-range band is refused", !C.setBand("LB", 30, 10) && !C.setBand("LB", 0, 140) && band("LB").mx === 18);
  ok("the profit band is stored and read back", C.setBand("PROFIT", 10, 25) && C.profitBand().min === 10 && C.profitBand().max === 25);
  ok("no revenue → no percentages", C.buildCostRatios("2025-01", br).profitPct === null);

  cleanup();
  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log("\nAll cost guardrail tests passed");
})();
