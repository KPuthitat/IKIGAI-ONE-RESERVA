// npx tsx scripts/test-svc-meeting-review.ts — meeting-fee review card data (owner 2026-10-20)
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-svc-meeting-review.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); process.env.DATABASE_PATH = TMP;
let failed = 0;
function ok(name: string, cond: boolean) { console.log(`  ${cond ? "✓" : "✗"} ${name}`); if (!cond) failed++; }
(async () => {
  const { getDb } = await import("../src/lib/db");
  const { meetingFeeReview } = await import("../src/lib/svc-meeting-review");
  const db = getDb();
  const co = Number(db.prepare("INSERT INTO companies (name_th) VALUES ('บ')").run().lastInsertRowid);
  const br = Number(db.prepare("INSERT INTO branches (slug, name, company_id) VALUES ('nama','NAMA', ?)").run(co).lastInsertRowid);
  const mk = (n: string) => { const id = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,is_test_account) VALUES (?,?,?,?,?,0)").run(n, "x", n, "staff", "active").lastInsertRowid); db.prepare("INSERT INTO user_branches (user_id, branch_id, is_primary) VALUES (?,?,1)").run(id, br); return id; };
  const a = mk("a"), b = mk("b");
  const m1 = Number(db.prepare("INSERT INTO exec_meetings (branch_id,title,meeting_date,status) VALUES (?,?,?,?)").run(br, "ประชุมสัปดาห์", "2026-09-10", "ended").lastInsertRowid);
  for (const u of [a, b]) db.prepare("INSERT INTO exec_meeting_invitees (meeting_id,user_id) VALUES (?,?)").run(m1, u);
  db.prepare("INSERT INTO exec_meeting_attendance (meeting_id,user_id,ended_at,minutes,fee_amount) VALUES (?,?,CURRENT_TIMESTAMP,60,200)").run(m1, a);
  db.prepare("INSERT INTO exec_meeting_attendance (meeting_id,user_id) VALUES (?,?)").run(m1, b);   // joined, never finished
  const r = meetingFeeReview("2026-09", co);
  ok("the finished attendee shows with the fee", r.people.length === 1 && r.people[0].userId === a && r.people[0].gross === 200 && r.people[0].minutes === 60);
  ok("the meeting row shows 2 invited, 2 joined, 1 finished", r.meetings.length === 1 && r.meetings[0].invited === 2 && r.meetings[0].joined === 2 && r.meetings[0].finished === 1);
  ok("a month with no meetings is empty", meetingFeeReview("2026-08", co).people.length === 0 && meetingFeeReview("2026-08", co).beforeCutover);
  // exempt people never show, and confirming replaces the computed fees with the edited manual ones
  const ex = mk("ex");
  db.prepare("UPDATE users SET meeting_fee_exempt = 1 WHERE id = ?").run(ex);
  db.prepare("INSERT INTO exec_meeting_attendance (meeting_id,user_id,ended_at,minutes,fee_amount) VALUES (?,?,CURRENT_TIMESTAMP,140,450)").run(m1, ex);
  ok("an exempt person is left out even if a fee was stored before the flag", meetingFeeReview("2026-09", co).people.every((p) => p.userId !== ex));
  const S = await import("../src/lib/service-charge");
  ok("not confirmed yet", S.isMeetingFeeConfirmed("2026-09") === false);
  const c = S.confirmMeetingFees({ yearMonth: "2026-09", items: [{ userId: a, amount: 250 }, { userId: b, amount: 100 }], byUserId: a });
  ok("confirm stores the edited amounts as the month's fees", c.people === 2 && c.total === 350 && S.listManualMeetingFees("2026-09").get(a)?.amount === 250);
  const r2 = meetingFeeReview("2026-09", co);
  ok("after confirm only the confirmed amounts are paid (no computed on top)", S.isMeetingFeeConfirmed("2026-09") && r2.confirmed !== null && r2.totalGross === 350);
  S.confirmMeetingFees({ yearMonth: "2026-09", items: [{ userId: a, amount: 300 }], byUserId: a });
  ok("a re-confirm replaces the list; people left out are cleared", S.listManualMeetingFees("2026-09").size === 1 && meetingFeeReview("2026-09", co).totalGross === 300);
  cleanup(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
