// ประกาศนโยบาย / หนังสือแจ้งหลังประชุม. Run: node --import tsx scripts/test-policy-notices.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-policy-notices.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const P = await import("../src/lib/policy-notices");
  const N = await import("../src/lib/policy-notices-notify");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const code = (fn: () => unknown): string | null => { try { fn(); return null; } catch (e) { return e instanceof P.PolicyError ? e.code : `other:${(e as Error).message}`; } };

  const nama = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('nama','NAMA')").run().lastInsertRowid);
  const hypo = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('hypo','HYPO')").run().lastInsertRowid);
  const mk = (u: string, branch: number, extra: { role?: string; status?: string; test?: number; line?: string | null } = {}) => {
    const id = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,is_test_account,line_user_id) VALUES (?,?,?,?,?,?,?)")
      .run(u, "x", u, extra.role ?? "staff", extra.status ?? "active", extra.test ?? 0, extra.line === undefined ? `U-${u}` : extra.line).lastInsertRowid);
    db.prepare("INSERT INTO user_branches (user_id,branch_id) VALUES (?,?)").run(id, branch);
    return id;
  };
  const owner = mk("owner", nama, { role: "super_admin" });
  const a = mk("a", nama), b = mk("b", nama), c = mk("c", hypo), admin = mk("hr", nama, { role: "admin" });
  const gone = mk("gone", nama, { status: "resigned" }), off = mk("off", nama, { status: "disabled" }), test = mk("tst", nama, { test: 1 });

  const TH = "2026-10-15T14:00"; // a Thursday
  const id = P.createNotice({ title: "ตำแหน่งงานค่าตอบแทนพิเศษ", purpose: "ชี้แจงหลักเกณฑ์", meetingAt: TH, location: "ห้องประชุม", branchId: null }, owner);
  ok("a new notice is scheduled", P.getNotice(id)?.status === "scheduled");
  ok("an empty title is refused", code(() => P.createNotice({ title: "  " }, owner)) === "invalid_title");
  ok("a malformed meeting time is refused", code(() => P.createNotice({ title: "x", meetingAt: "15/10/2026 14:00" }, owner)) === "invalid_meeting_at");

  // meeting announcement
  const invited = P.inviteMeeting(id);
  const names = invited.map((r) => r.name).sort().join(",");
  ok("the audience is active employees of every branch (role staff/admin) — not the owner account, resigned, disabled or test accounts", names === "a,b,c,hr");
  ok("an employee sees the meeting before any letter exists, without topics", (() => { const l = P.listForUser(a); return l.length === 1 && l[0].status === "scheduled" && l[0].items === null; })());
  ok("inviting twice does not duplicate the recipients", P.inviteMeeting(id).length === 4);
  ok("nobody is told to acknowledge a notice that has no letter yet", P.pendingAckCount(a) === 0 && code(() => P.acknowledge(id, a)) === "not_published");

  // topics: any number, each with a heading + details (suggestions optional)
  ok("publishing without topics is refused", code(() => P.publish(id)) === "no_items");
  ok("a topic without details is refused", code(() => P.saveItems(id, [{ topic: "หัวข้อ", details: " ", suggestions: "" }])) === "invalid_item");
  ok("a failed save changes nothing (all or nothing)", P.listItems(id).length === 0);
  P.saveItems(id, [
    { topic: "หลักเกณฑ์การเลือกวัน", details: "เลือกได้ 6 วัน/ตำแหน่ง", suggestions: "ขอให้เลือกวันหยุดนักขัตฤกษ์ได้" },
    { topic: "การส่งหลักฐาน", details: "ถ่ายรูปภายในวันถัดไป", suggestions: "" },
    { topic: "การจ่ายเงิน", details: "จ่ายพร้อมเงินเดือน", suggestions: "อยากทราบยอดล่วงหน้า" }
  ]);
  ok("several topics are kept in order with their suggestions", (() => { const it = P.listItems(id); return it.length === 3 && it[0].topic === "หลักเกณฑ์การเลือกวัน" && it[0].suggestions.includes("นักขัตฤกษ์") && it[2].topic === "การจ่ายเงิน"; })());
  ok("more than 30 topics are refused", code(() => P.saveItems(id, Array.from({ length: 31 }, (_, i) => ({ topic: `t${i}`, details: "d", suggestions: "" })))) === "too_many_items");
  ok("meeting details can still be rescheduled before the letter", code(() => P.updateNotice(id, { title: "ตำแหน่งงานค่าตอบแทนพิเศษ", meetingAt: "2026-10-16T10:00", location: "ห้องประชุม", purpose: "ชี้แจงหลักเกณฑ์" })) === null);

  // a late joiner is picked up at publish
  const late = mk("late", nama);
  const sent = P.publish(id);
  ok("publishing sends to everyone including who joined after the invitation", sent.some((r) => r.userId === late) && sent.length === 5);
  ok("status is published", P.getNotice(id)?.status === "published");
  ok("the letter is locked: no edits, no new topics, no second publish", code(() => P.saveItems(id, [{ topic: "x", details: "y", suggestions: "" }])) === "locked" && code(() => P.updateNotice(id, { title: "เปลี่ยนชื่อ" })) === "locked" && code(() => P.publish(id)) === "bad_status");
  ok("employees now see the full letter with topics and suggestions", (() => { const l = P.listForUser(a)[0]; return l.status === "published" && l.items!.length === 3 && l.ackedAt === null; })());
  ok("an unacknowledged letter counts as pending", P.pendingAckCount(a) === 1);

  // acknowledge only
  const first = P.acknowledge(id, a);
  ok("pressing รับทราบ records the time", !first.already && !!first.ackedAt && P.pendingAckCount(a) === 0);
  const again = P.acknowledge(id, a);
  ok("a second press keeps the first timestamp", again.already && again.ackedAt === first.ackedAt);
  ok("someone not on the list cannot acknowledge", code(() => P.acknowledge(id, gone)) === "not_recipient");
  ok("employees never see other people's acknowledgements", JSON.stringify(P.listForUser(b)).indexOf(first.ackedAt) === -1);

  // admin tracking + reminders
  const d = P.adminDetail(id)!;
  ok("admin sees who acknowledged and who is still pending", d.recipients.length === 5 && d.recipients.filter((r) => r.ackedAt).length === 1 && d.recipients[0].ackedAt === null);
  db.prepare("UPDATE users SET title_prefix = 'นางสาว' WHERE id = ?").run(b);
  ok("admin lists carry the title prefix (and people without one are shown plainly)", (() => { const r = P.adminDetail(id)!.recipients; return r.some((x) => x.name === "นางสาว b") && r.some((x) => x.name === "a"); })());
  const list = P.listForAdmin().find((n) => n.id === id)!;
  ok("admin list shows the acknowledged count", list.recipientCount === 5 && list.ackedCount === 1);
  const rem = P.remindPending(id);
  ok("a reminder goes only to people who have not acknowledged", rem.length === 4 && !rem.some((r) => r.userId === a));
  const newer = mk("newer", nama);
  ok("the next reminder also reaches employees who joined after the letter", P.remindPending(id).some((r) => r.userId === newer));

  // closing
  P.closeNotice(id);
  ok("after closing, acknowledging is refused and the notice stays readable", code(() => P.acknowledge(id, b)) === "bad_status" && P.listForUser(b)[0].status === "closed");
  ok("closing twice or reminding a closed notice is refused", code(() => P.closeNotice(id)) === "bad_status" && code(() => P.remindPending(id)) === "bad_status");

  // branch-scoped notice + cancel
  const id2 = P.createNotice({ title: "เฉพาะสาขา HYPO", meetingAt: TH, branchId: hypo }, owner);
  ok("a branch notice goes only to that branch", P.inviteMeeting(id2).map((r) => r.name).join(",") === "c");
  P.cancelNotice(id2);
  ok("a cancelled notice disappears from the employee's list", P.listForUser(c).every((n) => n.id !== id2) && code(() => P.publish(id2)) === "bad_status");

  // LINE text
  ok("meeting time reads in Thai with the weekday", N.thaiMeetingTime(TH) === "วันพฤหัสบดีที่ 15 ต.ค. 2569 เวลา 14:00 น.");
  const flex = N.letterFlex({ title: "t", topics: Array.from({ length: 9 }, (_, i) => `หัวข้อ ${i + 1}`), ackDeadline: "2026-10-20", reminder: true, url: "https://x/y" });
  const body = JSON.stringify(flex);
  ok("the LINE card lists at most 6 topics and says how many more, with the deadline", body.includes("และอีก 3 หัวข้อ") && !body.includes("หัวข้อ 7") && body.includes("20/10/2026") && flex.altText.startsWith("เตือน"));
  cleanup(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
