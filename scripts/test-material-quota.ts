// Material-purchase quota, sales-weighted (owner 2026-10-04): the budget follows
// forecast sales, the month's target comes from ANALYTICA, and the sales base is
// the lower of target and projection. The worked example mirrors the owner's:
// target 1,000,000 · COG 35%, weekday averages from the HYPOPLARAEMIA screenshot.
// Run: node --import tsx scripts/test-material-quota.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-material-quota.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const sdb = await import("../src/lib/salesa-db");
  const mb = await import("../src/lib/material-budget");
  const st = await import("../src/lib/sales-target");
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (name: string, cond: boolean) => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.error(`  ✗ FAIL: ${name}`); } };
  const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

  const gdName = (db.prepare("SELECT name FROM accounta_categories WHERE code = 'GD'").get() as { name: string } | undefined)?.name ?? "ต้นทุนสินค้า/วัตถุดิบ";
  const mkBranch = (slug: string, extra = "") => {
    const id = Number(db.prepare("INSERT INTO branches (slug,name) VALUES (?,?)").run(slug, slug.toUpperCase()).lastInsertRowid);
    db.prepare(`UPDATE branches SET material_quota_enabled = 1, material_budget_pct = 35, material_purchase_weekday = 1, closed_weekdays = '[1]' ${extra} WHERE id = ?`).run(id);
    return id;
  };
  const spend = (b: number, date: string, amt: number) =>
    db.prepare("INSERT INTO accounta_expenses (branch_id,bill_date,category,amount_total,review_status) VALUES (?,?,?,?,'confirmed')").run(b, date, gdName, amt);

  // Weekday averages (Mon closed): the numbers from the owner's screenshot.
  const AVG: Record<number, number> = { 2: 20896.25, 3: 23441.88, 4: 22799.63, 5: 22956.5, 6: 40776.38, 0: 38723.71 };
  const history = (b: number) => {
    const ins = db.prepare("INSERT INTO salesa_daily (branch_id, sale_date, nett, has_sales) VALUES (?,?,?,1)");
    for (let d = new Date("2026-08-10T00:00:00Z"); d <= new Date("2026-10-04T00:00:00Z"); d = new Date(d.getTime() + 86_400_000)) {
      const a = AVG[d.getUTCDay()];
      if (a) ins.run(b, d.toISOString().slice(0, 10), a);
    }
  };

  // ── target: ANALYTICA first, PERSONA as the fallback ──
  const B = mkBranch("hypo", ", material_target_sales = 500000");
  history(B);
  ok("target: no ANALYTICA target → legacy PERSONA field (source persona)", (() => { const t = st.effectiveMonthlyTarget(B, "2026-10"); return t.target === 500000 && t.source === "persona"; })());
  sdb.setMonthlyTarget(B, 600000);
  ok("target: ANALYTICA branch default wins over PERSONA", (() => { const t = st.effectiveMonthlyTarget(B, "2026-10"); return t.target === 600000 && t.source === "analytica"; })());
  sdb.setMonthlyTargetFor(B, "2026-10", 1000000);
  sdb.setMonthlyTargetFor(B, "2026-11", 650000);
  ok("target: the month's own override wins (Oct 1,000,000 · Nov 650,000 · Dec = default 600,000)", st.effectiveMonthlyTarget(B, "2026-10").target === 1000000 && st.effectiveMonthlyTarget(B, "2026-11").target === 650000 && st.effectiveMonthlyTarget(B, "2026-12").target === 600000);
  ok("target: the sales-target bar reads it (and says where from)", (() => { const p = st.salesTargetProgress(B, "2026-10-05", 119537); return p.monthlyTarget === 1000000 && p.targetSource === "analytica" && p.monthPct === 12; })());
  ok("target: a branch with nothing set → none", st.effectiveMonthlyTarget(mkBranch("blank"), "2026-10").source === "none");

  // ── the owner's worked example: Mon 5 ต.ค. (purchase day), sales so far 119,537, bought 60,000 ──
  spend(B, "2026-10-03", 60000);
  const plan = mb.materialPlan(B, "2026-10-05", 119537);
  ok("plan: 26 remaining days (6–31 ต.ค.), forecast from weekday averages = 639,653.69", plan.days.length === 26 && plan.hasForecast && near(plan.days.reduce((s, d) => s + d.predicted, 0), 639653.69, 0.5));
  ok("plan: Mondays are closed (0)", plan.days.filter((d) => d.dow === 1).every((d) => d.closed && d.predicted === 0));
  const q = mb.materialQuotaFor(B, "2026-10-05", 119537)!;
  ok("worked example: projected month sales 759,190.69 < target → base = forecast", q.method === "forecast" && q.xBasis === "forecast" && near(q.xUsed, 759190.69, 0.5) && q.targetSales === 1000000 && q.targetSource === "analytica");
  ok("worked example: month budget 35% = 265,716.74 · bought 60,000 · remaining 205,716.74", near(q.monthBudget, 265716.74, 0.5) && q.spentThisMonth === 60000 && near(q.remainingBudget, 205716.74, 0.5));
  ok("worked example: purchase day covers 6–12 ต.ค. (7 days), forecast 169,594.35", q.todayIsPurchaseDay && q.windowFrom === "2026-10-06" && q.windowTo === "2026-10-12" && q.windowDays === 7 && near(q.windowForecast, 169594.35, 0.5));
  ok("worked example: weekly allowance ≈ 54,543 (= 205,716.74 × 169,594.35 ÷ 639,653.69)", near(q.quotaToday, 54542.63, 1) && q.quotaToday === q.quotaHigh && q.quotaLow === q.quotaHigh);
  ok("worked example: tomorrow (Tue 6 ต.ค., forecast 20,896.25) ≈ 6,720", q.nextDate === "2026-10-06" && near(q.nextForecast ?? 0, 20896.25, 0.5) && near(q.quotaNextHigh, 6720.37, 1));

  // Target below the projection → the target is the base.
  sdb.setMonthlyTargetFor(B, "2026-10", 600000);
  const q2 = mb.materialQuotaFor(B, "2026-10-05", 119537)!;
  ok("target 600,000 < projection → base = target; budget 210,000, remaining 150,000, weekly ≈ 39,770", q2.xBasis === "target" && q2.xUsed === 600000 && q2.monthBudget === 210000 && q2.remainingBudget === 150000 && near(q2.quotaToday, 39769.9, 1));
  sdb.setMonthlyTargetFor(B, "2026-10", 1000000);

  // Non-purchase day → tomorrow only.
  const q3 = mb.materialQuotaFor(B, "2026-10-07", 150000)!;
  ok("Wed 7 ต.ค. (not the purchase day): window = tomorrow only", !q3.todayIsPurchaseDay && q3.windowFrom === "2026-10-08" && q3.windowTo === "2026-10-08" && q3.windowDays === 1 && q3.quotaToday === q3.quotaNextHigh);

  // Goal range: 30% goal → a lower allowance.
  db.prepare("UPDATE branches SET material_budget_pct2 = 30 WHERE id = ?").run(B);
  const q4 = mb.materialQuotaFor(B, "2026-10-05", 119537)!;
  ok("goal 30% gives a range (low < high); high stays at the 35% ceiling", q4.goalPct === 30 && q4.quotaLow < q4.quotaHigh && near(q4.quotaHigh, 54542.63, 1));
  db.prepare("UPDATE branches SET material_budget_pct2 = NULL WHERE id = ?").run(B);

  // Overspent → zero allowance, negative remaining shows.
  spend(B, "2026-10-04", 250000);
  const q5 = mb.materialQuotaFor(B, "2026-10-05", 119537)!;
  ok("overspent month → allowance 0 and remaining negative", q5.quotaToday === 0 && q5.quotaNextHigh === 0 && q5.remainingBudget < 0);

  // ── no sales history → the old even spread, with the target as the base ──
  const C = mkBranch("fresh");
  sdb.setMonthlyTargetFor(C, "2026-10", 1000000);
  const qc = mb.materialQuotaFor(C, "2026-10-10", 0)!;
  ok("no history: method 'even', base = target, remaining ÷ days-left (350,000 ÷ 21 on a normal day)", qc.method === "even" && qc.xUsed === 1000000 && qc.monthBudget === 350000 && near(qc.quotaToday, 350000 / 21, 1));
  ok("quota off → null", (() => { const D = mkBranch("off"); db.prepare("UPDATE branches SET material_quota_enabled = 0 WHERE id = ?").run(D); return mb.materialQuotaFor(D, "2026-10-05", 0) === null; })());

  console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
