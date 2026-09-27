// ANALYTICA company daily labour cost (owner 2026-09-24). Actual clocked hours
// × each staff's rate (PT hourly, FT monthly/30/8), per day + monthly average,
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
  // PT @ ฿100/hr, FT @ ฿24,000/mo → 24000/30/8 = ฿100/hr.
  const pt = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,employment_type,hourly_rate) VALUES ('pt','x','PT','staff','active','pt',100)").run().lastInsertRowid);
  const ft = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,employment_type,monthly_salary) VALUES ('ft','x','FT','staff','active','ft',24000)").run().lastInsertRowid);

  // Roster-based COL (owner 2026-09-27): cost from roster_assignments × shift_codes,
  // not clocked hours. shift_code(branch, start, end) → its worked hours; a
  // roster_assignment(user, date, position, shift) books that user for the day.
  const shiftCode = (branch: number, code: string, st: string, et: string) =>
    Number(db.prepare("INSERT INTO shift_codes (branch_id, code, name, start_time, end_time) VALUES (?,?,?,?,?)").run(branch, code, code, st, et).lastInsertRowid);
  const pos = (branch: number, title: string) =>
    Number(db.prepare("INSERT INTO roster_positions (branch_id, title) VALUES (?,?)").run(branch, title).lastInsertRowid);
  const book = (branch: number, date: string, position: number, uid: number, shiftId: number) =>
    db.prepare("INSERT INTO roster_assignments (branch_id, assignment_date, position_id, user_id, shift_code_id) VALUES (?,?,?,?,?)").run(branch, date, position, uid, shiftId);

  const A8 = shiftCode(A, "A8", "09:00", "17:00");   // 8h
  const A2 = shiftCode(A, "A2", "09:00", "11:00");   // 2h
  const B4 = shiftCode(B, "B4", "09:00", "13:00");   // 4h
  const posA1 = pos(A, "A1"), posA2 = pos(A, "A2"), posB1 = pos(B, "B1");

  // Day 1: PT 8h + FT (full-day share) at A → PT 8*100=800 + FT 24000/30=800 = 1600.
  book(A, "2026-09-01", posA1, pt, A8);
  book(A, "2026-09-01", posA2, ft, A8);
  // Day 2: PT 4h at B → 4*100 = 400.
  book(B, "2026-09-02", posB1, pt, B4);
  // Day 3: PT 2h at A (labor ฿200) but NO sales imported yet — must not inflate COL%.
  book(A, "2026-09-03", posA1, pt, A2);

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
  ok("day 1: labor ฿1600 (PT 800 + FT 800)", d1.laborCost === 1600);
  ok("day 1: sales ฿10000, COL 16.0%", d1.salesNett === 10000 && d1.colPct === 16.0);
  ok("day 2: labor ฿400, COL 10.0%", d2.laborCost === 400 && d2.colPct === 10.0);
  ok("day 3: labor ฿200 but sales not imported → COL null", d3.laborCost === 200 && d3.salesNett === null && d3.colPct === null);
  ok("a day with no work → labor 0, no sales, COL null", d4.laborCost === 0 && d4.salesNett === null && d4.colPct === null);
  ok("total labor ฿2200 (incl. the no-sales day), total sales ฿14000", r.totalLabor === 2200 && r.totalSales === 14000);
  ok("avg per day = ฿440 (2200 ÷ 5 days)", r.avgLaborPerDay === 440);
  ok("avg COL = 14.3% — over days WITH sales only (2000 ÷ 14000), not inflated by the no-sales day", r.avgColPct === 14.3);
  ok("no company branches → empty", companyMonthLabor([], 2026, 9, "2026-09-05").days.length === 0);
  ok("past month uses the full month window (Aug = 31 days)", companyMonthLabor([A, B], 2026, 8, "2026-09-05").dayCount === 31);

  // branchTodayCol (the "today" widget) — roster-based, all branches (owner 2026-09-27).
  const { branchTodayCol } = await import("../src/lib/daily-col");
  const A4 = shiftCode(A, "A4", "09:00", "13:00");   // 4h
  // FT booked a 4h shift today → cost = 24000/30 = 800 (full daily share, NOT ÷8
  // and NOT pro-rated by the 4h). The FT never clocked in — roster alone counts.
  book(A, "2026-09-06", posA1, ft, A4);
  const t = branchTodayCol(A, "2026-09-06");
  ok("today: FT on a 4h shift costs the full ฿800 (salary/30, not ÷8, no clock)", t.laborCost === 800);
  ok("today: headcount counts the rostered FT (1 คน, ประจำ 1)", t.headcount === 1 && t.ftCount === 1 && t.ptCount === 0);
  ok("today: a day with no roster → 0 คน, ฿0", (() => { const z = branchTodayCol(A, "2026-09-20"); return z.headcount === 0 && z.laborCost === 0; })());
  // Day-off shift codes (kind='day_off') must NOT be costed/counted.
  const Aoff = Number(db.prepare("INSERT INTO shift_codes (branch_id,code,name,start_time,end_time,kind) VALUES (?,?,?,?,?,'day_off')").run(A, "OFF", "OFF", "00:00", "00:00").lastInsertRowid);
  book(A, "2026-09-07", posA1, pt, Aoff);
  ok("today: day-off shift is skipped (0 คน, ฿0 — not 24h)", (() => { const z = branchTodayCol(A, "2026-09-07"); return z.headcount === 0 && z.laborCost === 0; })());
  // A staffer on approved leave that day is excluded from cost + headcount.
  book(A, "2026-09-08", posA1, pt, A8);
  db.prepare("INSERT INTO leave_requests (user_id, type, date_from, date_to, days, status) VALUES (?, 'annual', ?, ?, 1, 'approved')").run(pt, "2026-09-08", "2026-09-08");
  ok("today: approved-leave day is excluded (0 คน, ฿0)", (() => { const z = branchTodayCol(A, "2026-09-08"); return z.headcount === 0 && z.laborCost === 0; })());

  console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})();
