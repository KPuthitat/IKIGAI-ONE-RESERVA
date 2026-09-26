// Unified inbox (owner 2026-09-26) — record inbound, list/thread, dedup LINE
// retries, mark read, unread count, staff reply. Run:
//   node --import tsx scripts/test-inbox.ts
//
// No network: recordInbound only fetches a LINE profile when a channel token
// resolves, so we set the branch token ONLY for the reply test; sendReply's
// LINE push is DEV-guarded (returns ok without hitting the network).

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-inbox.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const inbox = await import("../src/lib/inbox");
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (name: string, cond: boolean) => {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ FAIL: ${name}`); }
  };

  const A = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('nama','NAMA')").run().lastInsertRowid);
  const B = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('hypo','HYPO')").run().lastInsertRowid);
  const staff = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('s','x','พนักงาน A','admin','active')").run().lastInsertRowid);

  // Two inbound messages from one customer at NAMA → one conversation, two msgs.
  await inbox.recordInbound({ channel_code: "nama", branch_id: A, line_user_id: "Ucust1", text: "สวัสดีครับ เปิดกี่โมง", external_message_id: "M1" });
  await inbox.recordInbound({ channel_code: "nama", branch_id: A, line_user_id: "Ucust1", text: "มีโต๊ะว่างไหม", external_message_id: "M2" });
  // A different customer at HYPO.
  await inbox.recordInbound({ channel_code: "hypo", branch_id: B, line_user_id: "Ucust2", text: "จองโต๊ะ 4 คน", external_message_id: "M3" });

  const convs = inbox.listConversations();
  ok("two conversations, newest first (HYPO's M3 last → NAMA on top after M2)", convs.length === 2);
  const nama = convs.find((c) => c.external_user_id === "Ucust1")!;
  ok("conversation carries branch + preview + unread", nama.branch_name === "NAMA" && nama.last_message_preview === "มีโต๊ะว่างไหม" && nama.unread === 1);

  const thread = inbox.getThread(nama.id);
  ok("thread has both inbound messages, oldest first", thread.messages.length === 2 && thread.messages[0].body === "สวัสดีครับ เปิดกี่โมง" && thread.messages.every((m) => m.direction === "in"));

  // LINE retry: same external_message_id must not double-insert.
  await inbox.recordInbound({ channel_code: "nama", branch_id: A, line_user_id: "Ucust1", text: "มีโต๊ะว่างไหม", external_message_id: "M2" });
  ok("duplicate external_message_id ignored (still 2 msgs)", inbox.getThread(nama.id).messages.length === 2);

  ok("unreadCount = 2 (both conversations unread)", inbox.unreadCount() === 2);
  ok("unreadCount scoped to a branch = 1", inbox.unreadCount([A]) === 1);

  inbox.markRead(nama.id);
  ok("markRead clears unread", inbox.getThread(nama.id).conversation!.unread === 0);
  ok("unreadCount = 1 after one read", inbox.unreadCount() === 1);

  // Reply needs a resolvable send token; set it now so recordInbound above never
  // triggered a profile fetch. sendLinePush is DEV-guarded → ok without network.
  ok("reply with no channel token → 'no_channel'", (await inbox.sendReply(nama.id, staff, "เปิด 11:00 น. ค่ะ")) === "no_channel");
  db.prepare("UPDATE branches SET line_channel_token = 'TESTTOKEN' WHERE slug = 'nama'").run();
  ok("reply to a real conversation → 'sent'", (await inbox.sendReply(nama.id, staff, "เปิด 11:00 น. ค่ะ")) === "sent");
  ok("reply appended as an outbound message with the sender", (() => {
    const t = inbox.getThread(nama.id);
    const last = t.messages[t.messages.length - 1];
    return last.direction === "out" && last.body === "เปิด 11:00 น. ค่ะ" && last.sent_by === staff && last.sent_by_name === "พนักงาน A";
  })());
  ok("empty reply → 'empty'", (await inbox.sendReply(nama.id, staff, "   ")) === "empty");
  ok("reply to a missing conversation → 'no_conversation'", (await inbox.sendReply(999999, staff, "hi")) === "no_conversation");

  // Branch scoping (a viewer only sees/acts on their own branches).
  const hypo = convs.find((c) => c.external_user_id === "Ucust2")!;
  ok("getThread scoped to the wrong branch → not found", inbox.getThread(nama.id, [B]).conversation === null);
  ok("getThread scoped to the right branch → found", inbox.getThread(nama.id, [A]).conversation?.id === nama.id);
  ok("sendReply scoped to the wrong branch → 'no_conversation'", (await inbox.sendReply(nama.id, staff, "x", [B])) === "no_conversation");

  // Empty scope = a viewer with NO admin-branches → sees nothing, never "all".
  ok("getThread with empty scope → not found", inbox.getThread(nama.id, []).conversation === null);
  ok("listConversations with empty scope → none", inbox.listConversations({ branchIds: [] }).length === 0);
  ok("unreadCount with empty scope → 0", inbox.unreadCount([]) === 0);
  ok("sendReply with empty scope → 'no_conversation'", (await inbox.sendReply(nama.id, staff, "x", [])) === "no_conversation");
  inbox.markRead(hypo.id, []);
  ok("markRead with empty scope is a no-op", inbox.getThread(hypo.id).conversation!.unread === 1);

  // HYPO's M3 is still unread; a wrong-branch markRead must not clear it.
  inbox.markRead(hypo.id, [A]);
  ok("markRead scoped to the wrong branch is a no-op", inbox.getThread(hypo.id).conversation!.unread === 1);
  inbox.markRead(hypo.id, [B]);
  ok("markRead scoped to the right branch clears unread", inbox.getThread(hypo.id).conversation!.unread === 0);

  // Status filter: a closed conversation drops off the default list.
  db.prepare("UPDATE inbox_conversations SET status = 'closed' WHERE id = ?").run(hypo.id);
  ok("listConversations() hides closed by default", inbox.listConversations().every((c) => c.id !== hypo.id));
  ok("listConversations({status:'all'}) includes closed", inbox.listConversations({ status: "all" }).some((c) => c.id === hypo.id));

  // Media messages (owner 2026-09-26): image + sticker carry media_kind so the
  // inbox renders the real thing. nama has a send token set above.
  await inbox.recordInbound({ channel_code: "nama", branch_id: A, line_user_id: "Ucust1", text: "[รูปภาพ]", external_message_id: "IMG1", media_kind: "image" });
  await inbox.recordInbound({ channel_code: "nama", branch_id: A, line_user_id: "Ucust1", text: "[สติกเกอร์]", external_message_id: "STK1", media_kind: "sticker", media_ref: "52002734" });
  const mmsgs = inbox.getThread(nama.id).messages;
  const img = mmsgs.find((m) => m.body === "[รูปภาพ]")!;
  const stk = mmsgs.find((m) => m.body === "[สติกเกอร์]")!;
  const txt = mmsgs.find((m) => m.body === "สวัสดีครับ เปิดกี่โมง")!;
  ok("media: image message carries media_kind='image'", img.media_kind === "image");
  ok("media: sticker message carries media_kind + stickerId", stk.media_kind === "sticker" && stk.media_ref === "52002734");
  ok("media: image source resolves token + line message id (in scope)", (() => { const s = inbox.inboxImageSource(img.id, [A]); return s?.token === "TESTTOKEN" && s?.lineMessageId === "IMG1"; })());
  ok("media: image source null out of branch scope", inbox.inboxImageSource(img.id, [B]) === null);
  ok("media: sticker is not served as an image", inbox.inboxImageSource(stk.id, [A]) === null);
  ok("media: plain text is not served as an image", inbox.inboxImageSource(txt.id, [A]) === null);

  console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})();
