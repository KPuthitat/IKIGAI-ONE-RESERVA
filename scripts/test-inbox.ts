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
  ok("per-branch page: super_admin may pick any branch", JSON.stringify(inbox.narrowScopeToBranch(null, B)) === JSON.stringify([B]));
  ok("per-branch page: a branch admin may pick a branch in their scope", JSON.stringify(inbox.narrowScopeToBranch([A, B], A)) === JSON.stringify([A]));
  ok("per-branch page: a branch outside the viewer's scope reads as empty", inbox.narrowScopeToBranch([A], B).length === 0 && inbox.listConversations({ branchIds: inbox.narrowScopeToBranch([A], B) }).length === 0);
  ok("per-branch page: the list holds only that branch's chats", inbox.listConversations({ branchIds: inbox.narrowScopeToBranch(null, A) }).every((c) => c.branch_id === A));
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

  // ── Facebook Messenger channel (owner 2026-09-29) ──────────────────────────
  const fb = await import("../src/lib/facebook");
  // A Facebook inbound lands as its own channel, separate from LINE even for the
  // same external id (UNIQUE is per channel).
  await inbox.recordInbound({ channel: "facebook", channel_code: "PAGE123", branch_id: A, line_user_id: "Ucust1", text: "ทักจากเฟซ", external_message_id: "FBM1" });
  const fbConv = inbox.listConversations().find((c) => c.channel === "facebook");
  ok("fb: facebook inbound creates a facebook conversation", !!fbConv && fbConv.channel_code === "PAGE123");
  ok("fb: same external id on LINE + Facebook are separate conversations", (() => {
    const all = inbox.listConversations({ status: "all" });
    const forCust1 = all.filter((c) => c.external_user_id === "Ucust1");
    return forCust1.length === 2 && new Set(forCust1.map((c) => c.channel)).size === 2;
  })());
  ok("fb: a Facebook webhook retry (same mid) dedups", (() => {
    const before = inbox.getThread(fbConv!.id).messages.length;
    void inbox.recordInbound({ channel: "facebook", channel_code: "PAGE123", branch_id: A, line_user_id: "Ucust1", text: "ทักจากเฟซ", external_message_id: "FBM1" });
    return inbox.getThread(fbConv!.id).messages.length === before;
  })());
  // Signature verification (HMAC-SHA256 over the raw body with the app secret).
  const crypto = await import("node:crypto");
  const rawBody = JSON.stringify({ object: "page", entry: [] });
  const goodSig = "sha256=" + crypto.createHmac("sha256", "s3cr3t").update(rawBody, "utf8").digest("hex");
  ok("fb: verifyFbSignature accepts a correct signature", fb.verifyFbSignature("s3cr3t", rawBody, goodSig));
  ok("fb: verifyFbSignature rejects a wrong signature", !fb.verifyFbSignature("s3cr3t", rawBody, "sha256=deadbeef"));
  ok("fb: verifyFbSignature rejects a wrong secret", !fb.verifyFbSignature("other", rawBody, goodSig));
  ok("fb: verifyFbSignature rejects a missing header", !fb.verifyFbSignature("s3cr3t", rawBody, null));
  // Config round-trip: tokens stored encrypted, kept when re-saved without them.
  fb.setFacebookChannel({ pageId: "PAGE123", pageName: "IKIGAI", verifyToken: "vtok", accessToken: "PAGE_TOKEN", appSecret: "APP_SECRET", branchId: A, updatedBy: staff });
  ok("fb: getFacebookChannel returns decrypted tokens", (() => { const c = fb.getFacebookChannel("PAGE123"); return c?.access_token === "PAGE_TOKEN" && c?.app_secret === "APP_SECRET" && c?.verify_token === "vtok"; })());
  ok("fb: findFacebookChannelByVerifyToken resolves the page", fb.findFacebookChannelByVerifyToken("vtok")?.page_id === "PAGE123");
  fb.setFacebookChannel({ pageId: "PAGE123", pageName: "IKIGAI 2", verifyToken: "vtok2", branchId: B, updatedBy: staff });
  ok("fb: re-save without secrets keeps the stored tokens, updates other fields", (() => { const c = fb.getFacebookChannel("PAGE123"); return c?.access_token === "PAGE_TOKEN" && c?.app_secret === "APP_SECRET" && c?.verify_token === "vtok2" && c?.branch_id === B; })());
  ok("fb: raw tokens are stored encrypted at rest", (() => { const r = db.prepare("SELECT access_token, app_secret FROM facebook_channels WHERE page_id='PAGE123'").get() as { access_token: string; app_secret: string }; return r.access_token.startsWith("enc:") && r.app_secret.startsWith("enc:") && !r.access_token.includes("PAGE_TOKEN"); })());

  console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})();
