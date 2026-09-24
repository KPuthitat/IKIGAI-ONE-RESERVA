// ANALYTICA company daily labour cost (owner 2026-09-24). Actual clocked hours
// × each staff's rate (PT hourly, FT monthly/22/8), per day + monthly average,
// COL% vs SALESA daily nett. Run: node --import tsx scripts/test-analytica-labor.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-analytica-labor.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const { companyMonthLabor } = await import("../src/lib/daily-col");
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (name: string, cond: boolean) => {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ FAIL: ${name}`); }
  };

  const A = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('a','NAMA')").run().lastInsertRowid);
  const B = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('b','HYPO')").run().lastInsertRowid);
  // PT @ ฿100/hr, FT @ ฿22,000/mo → 22000/22/8 = ฿125/hr.
  const pt = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,employment_type,hourly_rate) VALUES ('pt','x','PT','staff','active','pt',100)").run().lastInsertRowid);
  const ft = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,employment_type,monthly_salary) VALUES ('ft','x','FT','staff','active','ft',22000)").run().lastInsertRowid);

  const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+07:00`).toISOString();
  const punch = (uid: number, date: string, hhmm: string, type: "in" | "out", branch: number) =>
    db.prepare("INSERT INTO time_entries (user_id, type, ts, branch_id) VALUES (?,?,?,?)").run(uid, type, at(date, hhmm), branch);
  const shift = (uid: number, date: string, inHH: string, outHH: string, branch: number) => { punch(uid, date, inHH, "in", branch); punch(uid, date, outHH, "out", branch); };

  // Day 1: PT 8h + FT 8h at A → 8*100 + 8*125 = 1800.
  shift(pt, "2026-09-01", "09:00", "17:00", A);
  shift(ft, "2026-09-01", "09:00", "17:00", A);
  // Day 2: PT 4h at B → 4*100 = 400.
  shift(pt, "2026-09-02", "09:00", "13:00", B);
  // Day 3: PT 2h at A (labor ฿200) but NO sales imported yet — must not inflate COL%.
  shift(pt, "2026-09-03", "09:00", "11:00", A);

  // has_sales = 1 so it counts as sales (matches the rest of the ANALYTICA page).
  const sale = (branch: number, date: string, nett: number) =>
    db.prepare("INSERT INTO salesa_daily (branch_id, sale_date, nett, has_sales) VALUES (?,?,?,1)").run(branch, date, nett);
  sale(A, "2026-09-01", 10000);
  sale(B, "2026-09-02", 4000);

  const r = companyMonthLabor([A, B], 2026, 9, "2026-09-05"); // current month, through day 5

  ok("window = 5 days (1–5 Sep)", r.days.length === 5 && r.dayCount === 5);
  const d1 = r.days.find((d) => d.date === "2026-09-01")!;
  const d2 = r.days.find((d) => d.date === "2026-09-02")!;
  const d3 = r.days.find((d) => d.date === "2026-09-03")!;
  const d4 = r.days.find((d) => d.date === "2026-09-04")!;
  ok("day 1: labor ฿1800 (PT 800 + FT 1000)", d1.laborCost === 1800);
  ok("day 1: sales ฿10000, COL 18.0%", d1.salesNett === 10000 && d1.colPct === 18.0);
  ok("day 2: labor ฿400, COL 10.0%", d2.laborCost === 400 && d2.colPct === 10.0);
  ok("day 3: labor ฿200 but sales not imported → COL null", d3.laborCost === 200 && d3.salesNett === null && d3.colPct === null);
  ok("a day with no work → labor 0, no sales, COL null", d4.laborCost === 0 && d4.salesNett === null && d4.colPct === null);
  ok("total labor ฿2400 (incl. the no-sales day), total sales ฿14000", r.totalLabor === 2400 && r.totalSales === 14000);
  ok("avg per day = ฿480 (2400 ÷ 5 days)", r.avgLaborPerDay === 480);
  ok("avg COL = 15.7% — over days WITH sales only (2200 ÷ 14000), not inflated by the no-sales day", r.avgColPct === 15.7);
  ok("no company branches → empty", companyMonthLabor([], 2026, 9, "2026-09-05").days.length === 0);
  ok("past month uses the full month window (Aug = 31 days)", companyMonthLabor([A, B], 2026, 8, "2026-09-05").dayCount === 31);

  console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})();
