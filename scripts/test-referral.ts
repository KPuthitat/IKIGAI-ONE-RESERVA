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

  console.log(`\ntest-referral: ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})();
