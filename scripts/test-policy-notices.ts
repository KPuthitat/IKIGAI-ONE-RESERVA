// ประกาศนโยบาย / หนังสือแจ้งหลังประชุม. Run: node --import tsx scripts/test-policy-notices.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-policy-notices.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;
const IMG_DIR = path.join(process.cwd(), "data", "test-policy-images"); fs.rmSync(IMG_DIR, { recursive: true, force: true }); process.env.POLICY_IMAGE_DIR = IMG_DIR;

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
  // announcer
  db.prepare("UPDATE users SET title_prefix = 'นพ.' WHERE id = ?").run(owner);
  const ann = P.createNotice({ title: "ผู้ประกาศ", meetingAt: TH }, owner);
  ok("the announcer defaults to the creator, with title prefix", P.getNotice(ann)!.announcer === "นพ. owner");
  P.updateNotice(ann, { title: "ผู้ประกาศ", meetingAt: TH, announcer: "  ผู้อำนวยการ  " });
  ok("an announcer can be typed in and is trimmed", P.getNotice(ann)!.announcer === "ผู้อำนวยการ");
  P.updateNotice(ann, { title: "ผู้ประกาศ", meetingAt: TH, announcer: "" });
  ok("clearing it falls back to the creator again", P.getNotice(ann)!.announcer === "นพ. owner");
  P.inviteMeeting(ann);
  ok("employees see who announced", P.listForUser(a).find((n) => n.id === ann)?.announcer === "นพ. owner");
  // anonymous suggestions + follow-up letters
  const id5 = P.createNotice({ title: "ข้อเสนอแนะ", meetingAt: TH }, owner);
  P.saveItems(id5, [{ topic: "หัวข้อ", details: "รายละเอียด", suggestions: "" }]);
  P.publish(id5);
  const cols = (db.prepare("PRAGMA table_info(policy_notice_suggestions)").all() as Array<{ name: string }>).map((c) => c.name);
  ok("suggestions are stored without any user column", !cols.some((c) => /user|who|by/i.test(c)));
  P.acknowledge(id5, a, "  อยากให้เลือกวันหยุดนักขัตฤกษ์ได้  ");
  P.acknowledge(id5, b, "");
  P.acknowledge(id5, c, "ขอให้ชี้แจงเรื่องภาษีเพิ่ม");
  ok("only non-empty suggestions are kept, trimmed", P.listSuggestions(id5).map((x) => x.body).join("|") === "ขอให้ชี้แจงเรื่องภาษีเพิ่ม|อยากให้เลือกวันหยุดนักขัตฤกษ์ได้");
  ok("a second press does not add a second suggestion", (() => { P.acknowledge(id5, a, "ซ้ำ"); return P.listSuggestions(id5).length === 2; })());
  ok("a suggestion carries only the day, not a time that could be matched to an acknowledgement", P.listSuggestions(id5).every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.day)));
  ok("an over-long suggestion is refused and the acknowledgement is not recorded", code(() => P.acknowledge(id5, admin, "ก".repeat(2001))) === "invalid_suggestion" && P.adminDetail(id5)!.recipients.find((r) => r.userId === admin)!.ackedAt === null);
  ok("the admin detail carries the suggestions and no AI digest yet", (() => { const d = P.adminDetail(id5)!; return d.suggestions.length === 2 && d.aiSummary === null; })());
  P.saveAiSummary(id5, "### ภาพรวม\nทดสอบ");
  ok("an AI digest is stored on the notice", P.adminDetail(id5)!.aiSummary?.includes("ภาพรวม") === true);
  ok("a follow-up can only continue a notice that has been sent", code(() => P.createFollowUp(ann, owner)) === "bad_status");
  const fu = P.createFollowUp(id5, owner);
  ok("a follow-up starts as a draft for the same audience, pointing at the original", (() => { const n = P.getNotice(fu)!; return n.status === "scheduled" && n.parentId === id5 && n.title === "ฉบับแก้ไข: ข้อเสนอแนะ" && n.branchId === null; })());
  ok("the original lists its follow-ups", P.adminDetail(id5)!.followUps.map((f) => f.id).join() === String(fu));
  P.saveItems(fu, [{ topic: "ปรับเงื่อนไข", details: "ปรับตามข้อเสนอ", suggestions: "ข้อเสนอเรื่องวันหยุด — รับไปพิจารณาแล้ว" }]);
  P.publish(fu);
  ok("employees see the follow-up with its parent", (() => { const n = P.listForUser(a).find((x) => x.id === fu); return !!n && n.parent?.id === id5 && n.parent.title === "ข้อเสนอแนะ"; })());
  // pictures (infographic)
  const id3 = P.createNotice({ title: "ภาพอินโฟกราฟิก", meetingAt: TH }, owner);
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const img1 = P.addImage(id3, png, "image/png");
  const img2 = P.addImage(id3, png, "image/jpeg");
  ok("pictures attach to a draft in order", P.listImages(id3).map((i) => i.id).join() === `${img1},${img2}`);
  ok("a non-image type and an oversized file are refused", code(() => P.addImage(id3, png, "application/pdf")) === "invalid_image" && code(() => P.addImage(id3, Buffer.alloc(P.MAX_IMAGE_BYTES + 1), "image/png")) === "image_too_large");
  P.removeImage(id3, img2);
  ok("a picture can be removed from a draft", P.listImages(id3).length === 1 && code(() => P.removeImage(id3, img2)) === "not_found");
  const sent3 = P.publish(id3); ok("a letter with only a picture (no topics) can be sent", sent3.length === 6);
  ok("pictures are locked once the letter is sent", code(() => P.addImage(id3, png, "image/png")) === "locked" && code(() => P.removeImage(id3, img1)) === "locked");
  ok("an employee's list carries the pictures of a sent letter", P.listForUser(a).find((n) => n.id === id3)?.images.length === 1);
  ok("a recipient and an admin may open the picture, an outsider may not", !!P.imageForViewer(img1, { userId: a, isAdmin: false }) && !!P.imageForViewer(img1, { userId: owner, isAdmin: true }) && P.imageForViewer(img1, { userId: gone, isAdmin: false }) === null);
  const id4 = P.createNotice({ title: "ร่าง", meetingAt: TH }, owner);
  const draftImg = P.addImage(id4, png, "image/png");
  ok("a draft's picture is hidden from employees until the letter is sent", P.imageForViewer(draftImg, { userId: a, isAdmin: false }) === null);
  ok("a letter with no topics and no pictures is still refused", code(() => P.publish(P.createNotice({ title: "ว่าง" }, owner))) === "no_items");
  fs.rmSync(IMG_DIR, { recursive: true, force: true });
  cleanup(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
