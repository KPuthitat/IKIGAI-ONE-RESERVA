// Unified customer-chat inbox (owner 2026-09-26). Inbound messages from every
// customer channel land in inbox_conversations / inbox_messages so staff reply
// from one back-office screen. Phase 1: LINE OA (per branch), human reply.
//
// channel_code is the webhook code (messaging_channels.code / branch slug) — the
// same key the webhook resolved the channel with, so a reply resolves the SAME
// send token. Everything here is operational (no INSIGNA wall): it stores the
// raw LINE userId + display name, like review_invites, because staff must see
// and reply to a real person.

import { getDb } from "./db";
import { getChannelByCode } from "./messaging-channels";
import { decryptSecret } from "./secret-vault";
import { sendLinePush, getLineProfile } from "./line";

/** Resolve a channel code to its LINE send token — new messaging_channels table
 *  first, then the legacy per-branch token on branches.slug (mirrors the
 *  webhook's resolveChannel so replies work for every OA the webhook accepts). */
function channelToken(code: string): string | null {
  const ch = getChannelByCode(code);
  if (ch?.channel_token) return ch.channel_token;
  const b = getDb().prepare("SELECT line_channel_token FROM branches WHERE slug = ?")
    .get(code) as { line_channel_token: string | null } | undefined;
  return b?.line_channel_token ? decryptSecret(b.line_channel_token) : null;
}

/** true when branchId falls inside the given scope. null/undefined = unscoped
 *  (super-admin / server internals / tests) → always true. An explicit array is
 *  a real allow-list: an EMPTY array means "no branches" → always false, never
 *  "all" — so a viewer with no admin-branches can never see another branch's
 *  chats even if a caller forgets to pre-check. */
function inScope(branchIds: number[] | null | undefined, branchId: number | null): boolean {
  if (branchIds == null) return true;
  return branchId != null && branchIds.includes(branchId);
}

export type RecordInboundArgs = {
  channel_code: string;
  branch_id: number | null;
  line_user_id: string;
  text: string;
  external_message_id?: string | null;
};

/** Record an inbound customer message: append it, then bump the conversation
 *  (recency + unread). Dedups LINE's webhook retries on external_message_id —
 *  the message INSERT happens FIRST so a retry stops before it can resurrect a
 *  read/closed conversation. The display name is fetched once for a brand-new
 *  conversation and never on the webhook's critical path (fire-and-forget, so a
 *  slow LINE profile call can't stall the ack and trigger a retry). Synchronous
 *  + best-effort — never throws into the webhook. */
export function recordInbound(args: RecordInboundArgs): void {
  const db = getDb();
  const preview = args.text.slice(0, 200);
  const extId = args.external_message_id ?? null;

  const insertMsg = () =>
    db.prepare(
      "INSERT INTO inbox_messages (conversation_id, direction, body, external_message_id) VALUES (?, 'in', ?, ?)"
    );

  const existing = db.prepare(
    "SELECT id FROM inbox_conversations WHERE channel = 'line' AND channel_code = ? AND external_user_id = ?"
  ).get(args.channel_code, args.line_user_id) as { id: number } | undefined;

  let convId: number;
  let isNew = false;

  if (existing) {
    convId = existing.id;
    // Dedup BEFORE mutating the conversation: insert the message first, and a
    // UNIQUE hit on external_message_id (a LINE retry) returns here — the
    // conversation's unread/status are left exactly as they were.
    try {
      insertMsg().run(convId, args.text, extId);
    } catch (e) {
      if (e instanceof Error && /UNIQUE/i.test(e.message)) return;
      throw e;
    }
    db.prepare(
      `UPDATE inbox_conversations
       SET last_message_at = datetime('now'), last_inbound_at = datetime('now'),
           last_message_preview = ?, unread = 1, status = 'open',
           branch_id = COALESCE(branch_id, ?)
       WHERE id = ?`
    ).run(preview, args.branch_id, convId);
  } else {
    convId = Number(db.prepare(
      `INSERT INTO inbox_conversations
         (channel, channel_code, branch_id, external_user_id, last_message_at, last_inbound_at, last_message_preview, unread)
       VALUES ('line', ?, ?, ?, datetime('now'), datetime('now'), ?, 1)`
    ).run(args.channel_code, args.branch_id, args.line_user_id, preview).lastInsertRowid);
    isNew = true;
    try {
      insertMsg().run(convId, args.text, extId);
    } catch (e) {
      // Extraordinary race (a retry created the conversation between our lookup
      // and insert): the empty conversation row is harmless — just stop.
      if (e instanceof Error && /UNIQUE/i.test(e.message)) return;
      throw e;
    }
  }

  // Fetch the display name once, only for a genuinely new conversation, and
  // never await it here — a slow profile call must not delay the webhook ack.
  if (isNew) {
    const token = channelToken(args.channel_code);
    if (token) {
      void getLineProfile(token, args.line_user_id)
        .then((prof) => {
          if (prof?.displayName) {
            db.prepare("UPDATE inbox_conversations SET display_name = ? WHERE id = ?")
              .run(prof.displayName, convId);
          }
        })
        .catch(() => { /* best-effort — name stays null, staff still see the chat */ });
    }
  }
}

export type InboxConversation = {
  id: number;
  channel_code: string;
  branch_id: number | null;
  branch_name: string | null;
  external_user_id: string;
  display_name: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread: number;
  status: string;
};

const CONV_COLS = `c.id, c.channel_code, c.branch_id, b.name AS branch_name, c.external_user_id,
  c.display_name, c.last_message_at, c.last_message_preview, c.unread, c.status`;

/** Conversation list for the inbox, newest activity first. Scope to branchIds
 *  (the viewer's branches) when given; null/empty = all. status defaults to
 *  'open' so resolved chats drop off the list; pass 'all' to include closed. */
export function listConversations(
  opts: { branchIds?: number[] | null; limit?: number; status?: "open" | "all" } = {}
): InboxConversation[] {
  const db = getDb();
  const limit = Math.min(300, Math.max(1, opts.limit ?? 100));
  let where = "1=1";
  const params: Array<string | number> = [];
  if (opts.branchIds != null) {
    if (opts.branchIds.length === 0) return [];   // no branches → no results
    where += ` AND c.branch_id IN (${opts.branchIds.map(() => "?").join(",")})`;
    params.push(...opts.branchIds);
  }
  if ((opts.status ?? "open") === "open") {
    where += " AND c.status = 'open'";
  }
  return db.prepare(
    `SELECT ${CONV_COLS} FROM inbox_conversations c LEFT JOIN branches b ON b.id = c.branch_id
     WHERE ${where} ORDER BY c.last_message_at DESC LIMIT ?`
  ).all(...params, limit) as InboxConversation[];
}

export type InboxMessage = {
  id: number;
  direction: "in" | "out";
  body: string;
  sent_by: number | null;
  sent_by_name: string | null;
  created_at: string;
};

/** One conversation + its full message history (oldest first). Scope to
 *  branchIds (the viewer's branches) when given; a conversation outside that
 *  scope reads as not found so staff can't open another branch's chats. */
export function getThread(
  conversationId: number,
  branchIds?: number[] | null
): { conversation: InboxConversation | null; messages: InboxMessage[] } {
  const db = getDb();
  const conversation = (db.prepare(
    `SELECT ${CONV_COLS} FROM inbox_conversations c LEFT JOIN branches b ON b.id = c.branch_id WHERE c.id = ?`
  ).get(conversationId) as InboxConversation | undefined) ?? null;
  if (!conversation || !inScope(branchIds, conversation.branch_id)) return { conversation: null, messages: [] };
  const messages = db.prepare(
    `SELECT m.id, m.direction, m.body, m.sent_by, u.display_name AS sent_by_name, m.created_at
     FROM inbox_messages m LEFT JOIN users u ON u.id = m.sent_by
     WHERE m.conversation_id = ? ORDER BY m.id ASC`
  ).all(conversationId) as InboxMessage[];
  return { conversation, messages };
}

/** Clear a conversation's unread flag. Scoped to branchIds when given (a
 *  conversation outside scope is a no-op). */
export function markRead(conversationId: number, branchIds?: number[] | null): void {
  const db = getDb();
  if (branchIds != null) {
    if (branchIds.length === 0) return;   // no branches → nothing to touch
    db.prepare(
      `UPDATE inbox_conversations SET unread = 0 WHERE id = ? AND branch_id IN (${branchIds.map(() => "?").join(",")})`
    ).run(conversationId, ...branchIds);
    return;
  }
  db.prepare("UPDATE inbox_conversations SET unread = 0 WHERE id = ?").run(conversationId);
}

/** Count of OPEN unread conversations (for the น้องฮูก badge). Only 'open'
 *  chats are actionable, so a resolved/closed chat never nags — this keeps the
 *  badge in step with the default (open) conversation list. Scope to branchIds. */
export function unreadCount(branchIds?: number[] | null): number {
  const db = getDb();
  if (branchIds != null) {
    if (branchIds.length === 0) return 0;   // no branches → nothing unread
    return (db.prepare(
      `SELECT COUNT(*) AS n FROM inbox_conversations WHERE unread = 1 AND status = 'open' AND branch_id IN (${branchIds.map(() => "?").join(",")})`
    ).get(...branchIds) as { n: number }).n;
  }
  return (db.prepare("SELECT COUNT(*) AS n FROM inbox_conversations WHERE unread = 1 AND status = 'open'").get() as { n: number }).n;
}

export type ReplyResult = "sent" | "no_conversation" | "no_channel" | "empty" | "push_failed";

/** Send a staff reply back out through the conversation's channel (LINE push —
 *  a human reply comes minutes later, past the free reply-token window), then
 *  record it and clear unread. Scope to branchIds when given: a conversation
 *  outside the viewer's branches reads as 'no_conversation'. */
export async function sendReply(
  conversationId: number,
  sentBy: number,
  text: string,
  branchIds?: number[] | null
): Promise<ReplyResult> {
  const body = text.trim();
  if (!body) return "empty";
  const db = getDb();
  const conv = db.prepare(
    "SELECT channel_code, external_user_id, branch_id FROM inbox_conversations WHERE id = ?"
  ).get(conversationId) as { channel_code: string; external_user_id: string; branch_id: number | null } | undefined;
  if (!conv || !inScope(branchIds, conv.branch_id)) return "no_conversation";
  const token = channelToken(conv.channel_code);
  if (!token) return "no_channel";

  const res = await sendLinePush(token, { to: conv.external_user_id, messages: [{ type: "text", text: body }] });
  if (!res.ok) return "push_failed";

  db.prepare(
    "INSERT INTO inbox_messages (conversation_id, direction, body, sent_by) VALUES (?, 'out', ?, ?)"
  ).run(conversationId, body, sentBy);
  db.prepare(
    "UPDATE inbox_conversations SET unread = 0, last_message_at = datetime('now'), last_message_preview = ? WHERE id = ?"
  ).run(body.slice(0, 200), conversationId);
  return "sent";
}
