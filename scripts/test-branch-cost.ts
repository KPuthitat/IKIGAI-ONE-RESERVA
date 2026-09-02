// Per-branch labour-cost allocation proof (owner 2026-09-02).
//
// Splits a full-time salary across branches by days clocked (split-day by
// minutes), incl. a payroll_day_branch override reassigning a whole day.
//
// Run:  node --import tsx scripts/test-branch-cost.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-branch-cost.db");
function cleanup() {
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
}
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const bc = await import("../src/lib/payroll-branch-cost");
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (name: string, cond: boolean) => {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ FAIL: ${name}`); }
  };
  const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

  const uid = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('t','x','T','staff','active')").run().lastInsertRowid);
  const A = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('a','NAMA')").run().lastInsertRowid);
  const B = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('b','HYPO')").run().lastInsertRowid);

  // BKK hh:mm on a date → UTC ISO.
  const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+07:00`).toISOString();
  const punch = (date: string, hhmm: string, type: "in" | "out", branch: number) =>
    db.prepare("INSERT INTO time_entries (user_id, type, ts, branch_id) VALUES (?,?,?,?)").run(uid, type, at(date, hhmm), branch);
  const fullDay = (date: string, branch: number) => { punch(date, "09:00", "in", branch); punch(date, "17:00", "out", branch); };

  // 3 full days at A, 1 full day at B, 1 split day (A 09–13, B 14–18).
  fullDay("2026-09-01", A); fullDay("2026-09-02", A); fullDay("2026-09-03", A);
  fullDay("2026-09-04", B);
  punch("2026-09-05", "09:00", "in", A); punch("2026-09-05", "13:00", "out", A);
  punch("2026-09-05", "14:00", "in", B); punch("2026-09-05", "18:00", "out", B);

  // Day weights: A = 3 + 0.5 = 3.5, B = 1 + 0.5 = 1.5, total 5.
  const w = bc.laborDayWeightsByBranch(db, uid, "2026-09-01", "2026-09-30");
  ok("day-weight A = 3.5", near(w.get(A) ?? 0, 3.5));
  ok("day-weight B = 1.5", near(w.get(B) ?? 0, 1.5));

  // Allocate 30000 → A 21000, B 9000.
  const alloc = new Map(bc.allocateLaborCostByBranch(db, uid, "2026-09-01", "2026-09-30", 30000).map((r) => [r.branchId, r.amount]));
  ok("allocate A = 21000 (3.5/5)", near(alloc.get(A) ?? 0, 21000));
  ok("allocate B = 9000 (1.5/5)", near(alloc.get(B) ?? 0, 9000));
  ok("allocation sums back to 30000", near((alloc.get(A) ?? 0) + (alloc.get(B) ?? 0), 30000));

  // payroll_day_branch override: move 2026-09-01 (clocked at A) to B.
  db.prepare("INSERT INTO payroll_day_branch (user_id, work_date, branch_id) VALUES (?,?,?)").run(uid, "2026-09-01", B);
  const w2 = bc.laborDayWeightsByBranch(db, uid, "2026-09-01", "2026-09-30");
  ok("override: A now 2.5", near(w2.get(A) ?? 0, 2.5));
  ok("override: B now 2.5", near(w2.get(B) ?? 0, 2.5));

  // Rounding: 100 across 3.5/1.5 → 70 / 30, sums exactly.
  const r = new Map(bc.allocateLaborCostByBranch(db, uid, "2026-09-02", "2026-09-30", 100).map((x) => [x.branchId, x.amount]));
  ok("no-override window sums to 100", near((r.get(A) ?? 0) + (r.get(B) ?? 0), 100));

  // ── ACCOUNTA: a company-wide FT round splits the salary cost per branch ──
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const payroll = await import("../src/lib/payroll-compute");
  const accounta = await import("../src/lib/accounta-db");
  const co = Number(db.prepare("INSERT INTO companies (name_th) VALUES ('IKIGAI')").run().lastInsertRowid);
  db.prepare("UPDATE branches SET company_id = ? WHERE id IN (?, ?)").run(co, A, B);
  db.prepare("UPDATE users SET employment_type='ft', monthly_salary=30000, pay_cycle='monthly', salary_tax_mode='wht', hire_date='2026-01-01' WHERE id=?").run(uid);
  db.prepare("INSERT OR IGNORE INTO user_branches (user_id, branch_id, is_primary) VALUES (?, ?, 1)").run(uid, A);
  db.prepare("INSERT OR IGNORE INTO user_branches (user_id, branch_id) VALUES (?, ?)").run(uid, B);
  // Company-wide FT period (branch NULL) — computes the full salary once.
  const pid = Number(db.prepare(
    "INSERT INTO payroll_periods (cycle,period_start,period_end,pay_date,status,branch_id,target,data_source) VALUES ('monthly','2026-09-01','2026-09-30','2026-10-05','draft',NULL,'ft','auto')"
  ).run().lastInsertRowid);
  payroll.computePayrollPeriod(db, pid);
  const nline = db.prepare("SELECT base_pay, net_pay FROM payroll_lines WHERE period_id=? AND user_id=?").get(pid, uid) as { base_pay: number; net_pay: number } | undefined;
  ok("company-wide: จ่ายเงินเดือนเต็ม 30000 ครั้งเดียว", !!nline && near(nline.base_pay, 30000));
  accounta.postPayrollToAccounta(pid, uid);
  const sal = db.prepare(
    "SELECT branch_id, amount_total FROM accounta_expenses WHERE payroll_period_id=? AND category='เงินเดือน/ค่าจ้าง' ORDER BY branch_id"
  ).all(pid) as Array<{ branch_id: number; amount_total: number }>;
  ok("ACCOUNTA: ต้นทุนเงินเดือนแยกเป็น 2 สาขา", sal.length === 2);
  ok("ACCOUNTA: ทุกสาขามี branch_id (ไม่มี NULL)", sal.every((s) => s.branch_id != null));
  const salSum = round2(sal.reduce((s, r) => s + r.amount_total, 0));
  ok("ACCOUNTA: รวมต้นทุนทุกสาขา = net จริง", !!nline && near(salSum, round2(nline.net_pay)));
  // Override earlier moved 2026-09-01 A→B → weights 2.5/2.5 → 50/50 split.
  const byBr = new Map(sal.map((s) => [s.branch_id, s.amount_total]));
  ok("ACCOUNTA: แบ่ง 50/50 ตามวันจริง (มี override)", near(byBr.get(A) ?? 0, byBr.get(B) ?? 0));

  console.log(`\nbranch-cost test: ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
