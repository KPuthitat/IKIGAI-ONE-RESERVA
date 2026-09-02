// ประชุมผู้บริหาร + เบี้ยประชุม — join/minutes/end + fee proof (owner 2026-09-02).
//
// Self-contained: builds a throwaway DB, invites a staff member, and proves the
// gating (only invited, active-only, no double join, minutes required to end)
// and the เบี้ยประชุม math (200 บาท/ชม., per-minute; exempt → 0).
//
// Run:  node --import tsx scripts/test-exec-meetings.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-exec-meetings.db");
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
  const em = await import("../src/lib/exec-meetings");
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (name: string, cond: boolean) => {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ FAIL: ${name}`); }
  };

  // ── pure fee helper ──
  ok("fee: 90 นาที = 300", em.meetingFeeForMinutes(90) === 300);
  ok("fee: 45 นาที = 150", em.meetingFeeForMinutes(45) === 150);
  ok("fee: 100 นาที = 333.33 (รายนาที)", em.meetingFeeForMinutes(100) === 333.33);
  ok("fee: 0 นาที = 0", em.meetingFeeForMinutes(0) === 0);

  const mkUser = (u: string, exempt = 0) => Number(db.prepare(
    "INSERT INTO users (username,password_hash,display_name,role,status,meeting_fee_exempt) VALUES (?,'x',?,'staff','active',?)"
  ).run(u, u, exempt).lastInsertRowid);
  const uid = mkUser("staff1");
  const other = mkUser("staff2");
  const execU = mkUser("boss", 1);   // ยกเว้นเบี้ยประชุม

  // ── create + invite ──
  const mid = em.createExecMeeting({ title: "ประชุมทดสอบ", meeting_date: "2026-09-02", branch_id: null, invitee_user_ids: [uid, execU], created_by: uid });
  ok("gating: ยังไม่เปิด → join ไม่ได้", em.joinMeeting(mid, uid) === "meeting_not_active");

  em.updateExecMeeting(mid, { status: "active" });
  ok("gating: คนไม่ได้เชิญ → join ไม่ได้", em.joinMeeting(mid, other) === "not_invited");
  ok("join: ผู้ได้รับเชิญเข้าร่วมได้", em.joinMeeting(mid, uid) === null);
  ok("gating: เข้าร่วมซ้ำไม่ได้", em.joinMeeting(mid, uid) === "already_joined");

  // ── end blocked until minutes complete ──
  const e0 = em.endMeeting(mid, uid);
  ok("gating: จบไม่ได้ถ้ารายงานไม่ครบ", "error" in e0 && e0.error === "minutes_incomplete");
  em.saveMinutes(mid, uid, { agenda: "วาระ", details: "รายละเอียด", suggestions: "ข้อเสนอ", action_plan: "แผน" });

  // backdate join by 90 minutes so the timer yields a real duration
  db.prepare("UPDATE exec_meeting_attendance SET joined_at = datetime('now','-90 minutes') WHERE meeting_id=? AND user_id=?").run(mid, uid);
  const e1 = em.endMeeting(mid, uid);
  ok("end: คิดเวลา 90 นาที", !("error" in e1) && e1.minutes === 90);
  ok("end: เบี้ยประชุม = 300 (200/ชม.)", !("error" in e1) && e1.fee === 300);
  ok("end: จบซ้ำไม่ได้", "error" in em.endMeeting(mid, uid));

  // ── exempt exec: attends but fee = 0 ──
  em.joinMeeting(mid, execU);
  em.saveMinutes(mid, execU, { agenda: "ก", details: "ข", suggestions: "ค", action_plan: "ง" });
  db.prepare("UPDATE exec_meeting_attendance SET joined_at = datetime('now','-60 minutes') WHERE meeting_id=? AND user_id=?").run(mid, execU);
  const e2 = em.endMeeting(mid, execU);
  ok("exempt: คิดเวลา 60 นาที", !("error" in e2) && e2.minutes === 60);
  ok("exempt: เบี้ยประชุม = 0 (ยกเว้น)", !("error" in e2) && e2.fee === 0);

  console.log(`\nexec-meetings test: ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
