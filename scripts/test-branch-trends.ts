// Per-branch daily trend (sales per day, spend per head) — Run: node --import tsx scripts/test-branch-trends.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-branch-trends.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const A = await import("../src/lib/salesa-analytics");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };

  const b1 = Number(db.prepare("INSERT INTO branches (slug,name,display_order) VALUES ('hypo','HYPO',1)").run().lastInsertRowid);
  const b2 = Number(db.prepare("INSERT INTO branches (slug,name,display_order) VALUES ('nama','NAMA',2)").run().lastInsertRowid);
  const clinic = Number(db.prepare("INSERT INTO branches (slug,name,display_order) VALUES ('clinic','CLINIC',3)").run().lastInsertRowid);
  const day = (b: number, date: string, nett: number, pax: number, hasSales = 1) =>
    db.prepare("INSERT INTO salesa_daily (branch_id, sale_date, nett, pax, bill_count, has_sales) VALUES (?, ?, ?, ?, 10, ?)").run(b, date, nett, pax, hasSales);
  // October (previous month): 2 days.  November: 3 days, one with no pax, one not imported (has_sales 0).
  day(b1, "2026-10-01", 10000, 50); day(b1, "2026-10-02", 20000, 100);
  day(b1, "2026-11-01", 12000, 40); day(b1, "2026-11-02", 18000, 60); day(b1, "2026-11-03", 6000, 0); day(b1, "2026-11-04", 999, 9, 0);
  day(b2, "2026-11-01", 5000, 25);

  const t = A.branchTrends([b1, b2, clinic], 2026, 11);
  const h = t.find((x) => x.branchId === b1)!;
  ok("branches come back in display order, one entry each", t.map((x) => x.branchName).join() === "HYPO,NAMA,CLINIC");
  ok("only days with imported sales are in the series (the has_sales=0 day is left out)", h.days.length === 3 && !h.days.some((d) => d.date === "2026-11-04"));
  ok("per head = nett ÷ pax for a day (12,000 ÷ 40 = 300)", h.days[0].perHead === 300 && h.days[1].perHead === 300);
  ok("a day with no pax has no per-head point (not zero, not infinity)", h.days[2].perHead === null);
  ok("average per day = Σnett ÷ days with sales: (12,000+18,000+6,000) ÷ 3 = 12,000", h.avgPerDay === 12000);
  ok("average per head is weighted, over days that have pax: 30,000 ÷ 100 = 300", h.avgPerHead === 300);
  ok("previous month figures: per day 15,000, per head 200", h.prevAvgPerDay === 15000 && h.prevAvgPerHead === 200 && h.prevDays.length === 2);
  ok("month-over-month %: per day −20%, per head +50%", h.perDayMomPct === -20 && h.perHeadMomPct === 50);
  const n = t.find((x) => x.branchId === b2)!;
  ok("a branch with no previous month has no % change", n.avgPerDay === 5000 && n.perDayMomPct === null && n.prevDays.length === 0);
  const c = t.find((x) => x.branchId === clinic)!;
  ok("a branch with no POS rows comes back empty, not zero-filled", c.days.length === 0 && c.avgPerDay === null && c.avgPerHead === null);
  ok("January looks back to December of the previous year", (() => { day(b1, "2025-12-31", 1000, 10); return A.branchTrends([b1], 2026, 1)[0].prevDays.length === 1; })());
  ok("moving average ignores gaps and warms up", (() => { const m = A.movingAverage([10, null, 20, 30], 3); return m[0] === 10 && m[1] === 10 && m[2] === 15 && m[3] === 25; })());

  // ── Whole-year view ──
  const yt = A.branchYearTrends([b1, b2, clinic], 2026);
  ok("year view: combined row first, then branches in display order", yt.map((x) => x.branchName).join() === "ทุกสาขารวม,HYPO,NAMA,CLINIC" && yt[0].branchId === 0);
  const yh = yt.find((x) => x.branchId === b1)!;
  ok("year view: 12 months, empty months are null not zero", yh.months.length === 12 && yh.months[0].avgPerDay === null && yh.months[0].salesDays === 0);
  ok("year view: Nov per day 12,000 and per head 300 (has_sales=0 day left out)", yh.months[10].salesDays === 3 && yh.months[10].avgPerDay === 12000 && yh.months[10].avgPerHead === 300);
  ok("year view: Oct per day 15,000, per head 200", yh.months[9].avgPerDay === 15000 && yh.months[9].avgPerHead === 200);
  ok("year view: whole-year per day 13,200 and weighted per head 240", yh.avgPerDay === 13200 && yh.avgPerHead === 240);
  ok("year view: previous year (Dec 2025) is behind it, with a YoY %", yh.prevMonths[11].avgPerDay === 1000 && yh.prevAvgPerDay === 1000 && yh.perDayYoyPct === 1220);
  const yc = yt[0];
  ok("combined row: Nov counts each calendar day once across branches (3 days, 41,000 → 13,666.67; per head 35,000 ÷ 125 = 280)", yc.months[10].salesDays === 3 && Math.abs((yc.months[10].avgPerDay ?? 0) - 13666.67) < 0.01 && yc.months[10].avgPerHead === 280);
  ok("a branch with no POS rows is empty for the year", (() => { const e = yt.find((x) => x.branchId === clinic)!; return e.avgPerDay === null && e.months.every((m) => m.salesDays === 0); })());

  cleanup();
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
})();
