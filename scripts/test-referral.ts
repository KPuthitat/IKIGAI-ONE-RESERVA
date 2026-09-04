// ระบบแนะนำคน (referral) — owner 2026-09-04.
//
// Proves recordReferralOnHire: carries the referrer onto the new employee,
// opens the referrals ledger (eligible_on = hire + 119 days), and the guards
// (no referrer / self / inactive referrer / idempotent).
//
// Run:  node --import tsx scripts/test-referral.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-referral.db");
function cleanup() {
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
}
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const ref = await import("../src/lib/referral");
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (name: string, cond: boolean) => {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ FAIL: ${name}`); }
  };

  const mkUser = (name: string, status = "active") => Number(db.prepare(
    "INSERT INTO users (username,password_hash,display_name,role,status,employment_type) VALUES (?,?,?,'staff',?, 'ft')"
  ).run(name, "x", name, status).lastInsertRowid);

  console.log("addDaysYmd:");
  ok("hire + 119 วัน (ข้ามเดือน)", ref.addDaysYmd("2026-08-01", 119) === "2026-11-28");

  console.log("\nrecordReferralOnHire:");
  const referrer = mkUser("referrer");
  const newbie = mkUser("newbie");
  ref.recordReferralOnHire(db, newbie, referrer, "2026-08-01");
  const row = db.prepare("SELECT * FROM referrals WHERE referred_user_id = ?").get(newbie) as Record<string, unknown> | undefined;
  ok("สร้าง referral row", !!row);
  ok("referrer ถูกคน", row?.referrer_user_id === referrer);
  ok("status = pending", row?.status === "pending");
  ok("reward = 500", row?.reward_amount === 500);
  ok("eligible_on = hire + 119", row?.eligible_on === "2026-11-28");
  ok("users.referred_by_user_id ผูกแล้ว",
    (db.prepare("SELECT referred_by_user_id AS r FROM users WHERE id = ?").get(newbie) as { r: number | null }).r === referrer);

  // Idempotent — a second call (e.g. re-hire) doesn't duplicate.
  ref.recordReferralOnHire(db, newbie, referrer, "2026-08-01");
  ok("idempotent (ไม่ซ้ำ)",
    (db.prepare("SELECT COUNT(*) AS n FROM referrals WHERE referred_user_id = ?").get(newbie) as { n: number }).n === 1);

  // Self-referral — no-op.
  const solo = mkUser("solo");
  ref.recordReferralOnHire(db, solo, solo, "2026-08-01");
  ok("self-referral → ไม่บันทึก",
    !db.prepare("SELECT 1 FROM referrals WHERE referred_user_id = ?").get(solo));

  // Inactive referrer — no-op.
  const resigned = mkUser("resigned", "resigned");
  const newbie2 = mkUser("newbie2");
  ref.recordReferralOnHire(db, newbie2, resigned, "2026-08-01");
  ok("ผู้แนะนำลาออกแล้ว → ไม่บันทึก",
    !db.prepare("SELECT 1 FROM referrals WHERE referred_user_id = ?").get(newbie2));

  // No referrer — no-op.
  const newbie3 = mkUser("newbie3");
  ref.recordReferralOnHire(db, newbie3, null, "2026-08-01");
  ok("ไม่มีผู้แนะนำ → ไม่บันทึก",
    !db.prepare("SELECT 1 FROM referrals WHERE referred_user_id = ?").get(newbie3));

  console.log("\nevaluateReferral / evaluateDueReferrals:");
  const co = Number(db.prepare("INSERT INTO companies (name_th) VALUES ('IKIGAI')").run().lastInsertRowid);
  const branch = Number(db.prepare("INSERT INTO branches (slug,name,company_id) VALUES ('b','B',?)").run(co).lastInsertRowid);
  const link = (uid: number) => db.prepare("INSERT INTO user_branches (user_id, branch_id, is_primary) VALUES (?,?,1)").run(uid, branch);
  const clockIn = (uid: number, ymd: string) => db.prepare(
    "INSERT INTO time_entries (user_id, type, ts, branch_id) VALUES (?,?,?,?)"
  ).run(uid, "in", new Date(`${ymd}T10:00:00+07:00`).toISOString(), branch);
  const statusOf = (uid: number) => (db.prepare("SELECT status FROM referrals WHERE referred_user_id=?").get(uid) as { status: string } | undefined)?.status;

  // A) retention fail — the referred employee has resigned.
  const refA = mkUser("refA"), empA = mkUser("empA"); link(empA);
  ref.recordReferralOnHire(db, empA, refA, "2026-01-01");     // eligible 2026-04-30 (past)
  db.prepare("UPDATE users SET status='resigned' WHERE id=?").run(empA);
  const evA = ref.evaluateReferral(db, { referred_user_id: empA, hire_date: "2026-01-01", eligible_on: "2026-04-30" });
  ok("ลาออก → ไม่ผ่าน (retention)", !evA.qualified && !evA.retentionOk && evA.reasons.includes("retention"));

  // B) no roster but clocked in → qualified (lenient, computable=false).
  const refB = mkUser("refB"), empB = mkUser("empB"); link(empB);
  ref.recordReferralOnHire(db, empB, refB, "2026-01-01");
  clockIn(empB, "2026-01-05"); clockIn(empB, "2026-02-10");
  const evB = ref.evaluateReferral(db, { referred_user_id: empB, hire_date: "2026-01-01", eligible_on: "2026-04-30" });
  ok("ไม่มี roster แต่ลงเวลา → ผ่าน (lenient)", evB.qualified && !evB.computable && evB.daysWorked === 2);

  // C) no clock at all → attendance fail.
  const refC = mkUser("refC"), empC = mkUser("empC"); link(empC);
  ref.recordReferralOnHire(db, empC, refC, "2026-01-01");
  const evC = ref.evaluateReferral(db, { referred_user_id: empC, hire_date: "2026-01-01", eligible_on: "2026-04-30" });
  ok("ไม่ลงเวลาเลย → ไม่ผ่าน (attendance)", !evC.qualified && evC.reasons.includes("attendance"));

  // D) evaluateDueReferrals — A/B/C are due; a far-future one stays pending.
  const refD = mkUser("refD"), empD = mkUser("empD"); link(empD);
  ref.recordReferralOnHire(db, empD, refD, "2030-01-01");     // eligible far future
  const res = ref.evaluateDueReferrals(db);
  ok("due → มีทั้ง qualified และ disqualified", res.qualified >= 1 && res.disqualified >= 1);
  ok("empB → qualified", statusOf(empB) === "qualified");
  ok("empA → disqualified", statusOf(empA) === "disqualified");
  ok("empD (ยังไม่ถึงกำหนด) → pending", statusOf(empD) === "pending");

  console.log("\npayReferral:");
  // not_qualified — a pending referral (empD) can't be paid.
  const empDref = (db.prepare("SELECT id FROM referrals WHERE referred_user_id=?").get(empD) as { id: number }).id;
  const pendPay = ref.payReferral(db, empDref);
  ok("pending → จ่ายไม่ได้ (not_qualified)", !pendPay.ok && pendPay.reason === "not_qualified");

  // no_open_round — qualified but the referrer has no draft payroll line.
  const refP = mkUser("refP"), empP = mkUser("empP"); link(empP);
  ref.recordReferralOnHire(db, empP, refP, "2026-01-01");
  db.prepare("UPDATE referrals SET status='qualified' WHERE referred_user_id=?").run(empP);
  const refPid = (db.prepare("SELECT id FROM referrals WHERE referred_user_id=?").get(empP) as { id: number }).id;
  const noRound = ref.payReferral(db, refPid);
  ok("qualified แต่ไม่มีรอบเปิด → no_open_round", !noRound.ok && noRound.reason === "no_open_round");

  // Happy path — open a draft round + line for the referrer, then pay.
  link(refP);
  const per = Number(db.prepare(
    "INSERT INTO payroll_periods (cycle,target,data_source,period_start,period_end,pay_date,status,branch_id) VALUES ('monthly','ft','auto','2026-09-01','2026-09-30','2026-10-05','draft',?)"
  ).run(branch).lastInsertRowid);
  db.prepare(`INSERT INTO payroll_lines
    (period_id,user_id,employee_code,display_name,employment_type,pay_cycle_snapshot,
     hourly_rate_snapshot,monthly_salary_snapshot,salary_tax_mode_snapshot,
     base_pay,ot_pay,service_charge,other_additions,gross_pay,sso_amount,tax_amount,other_deductions,net_pay,days_worked,leave_days)
    VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?,?)`)
    .run(per, refP, "E1", "refP", "ft", "monthly", null, 20000, "sso", 20000,0,0,0,20000,750,0,0,19250,0,0);
  const payRes = ref.payReferral(db, refPid);
  ok("จ่ายสำเร็จ", payRes.ok === true);
  ok("referral → paid", statusOf(empP) === "paid");
  ok("other_additions ของผู้แนะนำ +500",
    (db.prepare("SELECT other_additions AS o FROM payroll_lines WHERE period_id=? AND user_id=?").get(per, refP) as { o: number }).o === 500);
  ok("paid ซ้ำไม่ได้", !ref.payReferral(db, refPid).ok);

  console.log(`\ntest-referral: ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})();
