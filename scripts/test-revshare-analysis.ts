// Per-partner revenue-share analysis — Run: node --import tsx scripts/test-revshare-analysis.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-revshare-analysis.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const R = await import("../src/lib/revshare-db");
  const A = await import("../src/lib/revshare-analysis");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };

  const branch = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('hypo','HYPO')").run().lastInsertRowid);
  const other = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('nama','NAMA')").run().lastInsertRowid);
  const user = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('a','x','a','admin','active')").run().lastInsertRowid);
  const partner = R.createPartner(branch, { name: "จ้อจี้", start_date: "2026-06-01", vat_enabled: false })!;
  R.replaceTiers(partner, branch, [{ lower: 0, upper: 10000, rate: 0.1 }, { lower: 10000, upper: null, rate: 0.2 }]);
  const day = (iso: string, amount: number) => R.createRound(partner, branch, { period_start: iso, period_end: iso, sales_amount: amount }, user);
  // September: Mon 2026-09-07 = 4000, Tue 08 = 2000 → 6000 ; October: Mon 12 = 8000, Tue 13 = 6000 → 14000
  day("2026-09-07", 4000); day("2026-09-08", 2000);
  day("2026-10-12", 8000); day("2026-10-13", 6000);
  R.createCatchup(partner, branch, { sales_from: "2026-10-02", sales_to: "2026-10-02", sales_amount: 1000, counted_date: "2026-10-14" }, user);

  const a = A.partnerAnalysis(partner, branch, "2026-10", 3, "2026-10-14")!;
  const oct = a.months[2], sep = a.months[1], aug = a.months[0];
  ok("the window ends at the requested month and has 3 months", a.months.map((m) => m.ym).join() === "2026-08,2026-09,2026-10");
  ok("a month with nothing is zero, not missing", aug.sales === 0 && aug.tierGP === 0 && aug.momPct === null);
  ok("September = 6000 sales, 10% tier GP 600, 10% effective", sep.sales === 6000 && sep.tierGP === 600 && Math.abs(sep.gpPct - 0.1) < 1e-9);
  ok("October counts the catch-up: 14000 + 1000", oct.sales === 15000 && oct.catchup === 1000);
  ok("October GP is marginal: 1000 + 5000×20% = 2000", oct.tierGP === 2000);
  ok("month-over-month is 15000 vs 6000 = +150%", Math.abs((oct.momPct ?? 0) - 1.5) < 1e-9);
  ok("active days only count single-day rows with sales", oct.activeDays === 2 && oct.avgPerDay === 7000);
  ok("totals add up across the window", a.totals.sales === 21000 && a.totals.tierGP === 2600 && a.totals.catchup === 1000);
  ok("catch-up share of sales is shown", Math.abs(a.totals.catchupPct - 1000 / 21000) < 1e-9);
  ok("best days are ranked", a.bestDays[0].date === "2026-10-12" && a.bestDays[0].sales === 8000);
  ok("weekday pattern starts Monday: Mon avg (4000+8000)/2, Tue avg (2000+6000)/2", a.weekdays[0].label === "จันทร์" && a.weekdays[0].avg === 6000 && a.weekdays[1].avg === 4000 && a.weekdays[6].days === 0);
  ok("tier position: 15000 is in the 20% tier, no next tier", a.tier!.currentRate === 0.2 && a.tier!.nextFrom === null && a.tier!.remaining === null);
  ok("a smaller month shows how far the next tier is", (() => { const p = A.tierPosition(7500, [{ lower: 0, upper: 10000, rate: 0.1 }, { lower: 10000, upper: null, rate: 0.2 }])!; return p.currentRate === 0.1 && p.nextRate === 0.2 && p.remaining === 2500; })());
  ok("pace projects only the month in progress: 15000/14×31", a.pace !== null && a.pace.projected === round(15000 / 14 * 31));
  ok("no pace for a finished month", A.partnerAnalysis(partner, branch, "2026-09", 2, "2026-10-14")!.pace === null);
  ok("another branch cannot read this partner", A.partnerAnalysis(partner, other, "2026-10", 3, "2026-10-14") === null);
  ok("the picker lists only this branch's active partners", A.analysisPartners(branch).length === 1 && A.analysisPartners(other).length === 0);

  cleanup();
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
  function round(x: number) { return Math.round((x + Number.EPSILON) * 100) / 100; }
})();
