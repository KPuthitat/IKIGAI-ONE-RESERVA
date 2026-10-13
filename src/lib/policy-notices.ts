// ประกาศนโยบาย / หนังสือแจ้งหลังประชุม (owner 2026-10-12).
//
// Flow: scheduled (meeting announced to every employee) → published (after the meeting the
// admin sends a letter of topics: heading, details, the suggestions raised at the meeting;
// employees only press "รับทราบ") → closed. A scheduled notice can be cancelled.
//
// Rules this module enforces (all queries on policy_* live here):
//  - the letter is locked once published, so everyone acknowledges the same text;
//  - an acknowledgement is only for a published notice the person is a recipient of, is
//    recorded once and never overwritten;
//  - recipients are active employees (role staff/admin, not disabled/resigned/terminated/test),
//    in the notice's branch or every branch; the list is topped up when the letter is published
//    (staff who joined in between) but nobody is removed;
//  - employees never see who else was notified or who acknowledged.

import { getDb } from "./db";
import { sqlNameWithPrefix } from "./name";

export type NoticeStatus = "scheduled" | "published" | "closed" | "cancelled";

export class PolicyError extends Error {
  constructor(public code: PolicyErrorCode, message?: string) { super(message ?? code); }
}
export type PolicyErrorCode =
  | "invalid_title" | "invalid_meeting_at" | "invalid_item" | "no_items" | "too_many_items"
  | "not_found" | "locked" | "bad_status" | "not_recipient" | "not_published";

export const POLICY_ERROR_TH: Record<PolicyErrorCode, string> = {
  invalid_title: "กรุณาใส่ชื่อเรื่อง",
  invalid_meeting_at: "วันเวลาประชุมไม่ถูกต้อง",
  invalid_item: "ทุกหัวข้อต้องมีชื่อหัวข้อและรายละเอียด",
  no_items: "ต้องมีอย่างน้อย 1 หัวข้อก่อนส่งหนังสือ",
  too_many_items: "ใส่ได้ไม่เกิน 30 หัวข้อ",
  not_found: "ไม่พบรายการนี้",
  locked: "ส่งหนังสือไปแล้ว แก้ไขเนื้อหาไม่ได้",
  bad_status: "สถานะปัจจุบันทำรายการนี้ไม่ได้",
  not_recipient: "ท่านไม่ได้อยู่ในรายชื่อผู้รับ",
  not_published: "ยังไม่ได้ส่งหนังสือฉบับนี้"
};

export const MAX_ITEMS = 30;
const MAX_TOPIC = 200, MAX_DETAILS = 4000, MAX_SUGGEST = 4000, MAX_TITLE = 200, MAX_PURPOSE = 1000, MAX_LOCATION = 200;

export type NoticeItem = { topic: string; details: string; suggestions: string };
export type NoticeRow = {
  id: number; title: string; purpose: string; meetingAt: string | null; location: string;
  branchId: number | null; branchName: string | null; status: NoticeStatus; ackDeadline: string | null;
  createdAt: string; invitedAt: string | null; publishedAt: string | null; closedAt: string | null;
};
export type Recipient = { userId: number; name: string; lineUserId: string | null };

const nowIso = () => new Date().toISOString();
const MEETING_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type RawNotice = {
  id: number; title: string; purpose: string; meeting_at: string | null; location: string; branch_id: number | null;
  branch_name: string | null; status: NoticeStatus; ack_deadline: string | null; created_at: string;
  invited_at: string | null; published_at: string | null; closed_at: string | null;
};
const toRow = (r: RawNotice): NoticeRow => ({
  id: r.id, title: r.title, purpose: r.purpose, meetingAt: r.meeting_at, location: r.location, branchId: r.branch_id,
  branchName: r.branch_name, status: r.status, ackDeadline: r.ack_deadline, createdAt: r.created_at,
  invitedAt: r.invited_at, publishedAt: r.published_at, closedAt: r.closed_at
});
const SELECT_NOTICE = `SELECT n.*, b.name AS branch_name FROM policy_notices n LEFT JOIN branches b ON b.id = n.branch_id`;

function load(id: number): NoticeRow {
  const r = getDb().prepare(`${SELECT_NOTICE} WHERE n.id = ?`).get(id) as RawNotice | undefined;
  if (!r) throw new PolicyError("not_found");
  return toRow(r);
}
export function getNotice(id: number): NoticeRow | null {
  const r = getDb().prepare(`${SELECT_NOTICE} WHERE n.id = ?`).get(id) as RawNotice | undefined;
  return r ? toRow(r) : null;
}

export function listItems(noticeId: number): NoticeItem[] {
  return (getDb().prepare("SELECT topic, details, suggestions FROM policy_notice_items WHERE notice_id = ? ORDER BY sort_no, id").all(noticeId) as NoticeItem[]);
}

// ── create / edit ─────────────────────────────────────────────────────────────

export type NoticeInput = { title: string; purpose?: string; meetingAt?: string | null; location?: string; branchId?: number | null; ackDeadline?: string | null };

function clean(input: NoticeInput): { title: string; purpose: string; meeting_at: string | null; location: string; branch_id: number | null; ack_deadline: string | null } {
  const title = (input.title ?? "").trim();
  if (!title || title.length > MAX_TITLE) throw new PolicyError("invalid_title");
  const meetingAt = input.meetingAt ? input.meetingAt.trim() : null;
  if (meetingAt && !MEETING_AT.test(meetingAt)) throw new PolicyError("invalid_meeting_at");
  const deadline = input.ackDeadline ? input.ackDeadline.trim() : null;
  if (deadline && !DAY.test(deadline)) throw new PolicyError("invalid_meeting_at");
  return {
    title, purpose: (input.purpose ?? "").trim().slice(0, MAX_PURPOSE), meeting_at: meetingAt,
    location: (input.location ?? "").trim().slice(0, MAX_LOCATION), branch_id: input.branchId ?? null, ack_deadline: deadline
  };
}

export function createNotice(input: NoticeInput, actorId: number): number {
  const c = clean(input);
  const r = getDb().prepare(`INSERT INTO policy_notices (title, purpose, meeting_at, location, branch_id, status, ack_deadline, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)`).run(c.title, c.purpose, c.meeting_at, c.location, c.branch_id, c.ack_deadline, actorId, nowIso());
  return Number(r.lastInsertRowid);
}

/** Meeting details can change until the letter goes out; the letter's wording is locked after that. */
export function updateNotice(id: number, input: NoticeInput): void {
  const n = load(id);
  if (n.status !== "scheduled") throw new PolicyError(n.status === "published" || n.status === "closed" ? "locked" : "bad_status");
  const c = clean(input);
  getDb().prepare(`UPDATE policy_notices SET title = ?, purpose = ?, meeting_at = ?, location = ?, branch_id = ?, ack_deadline = ? WHERE id = ?`)
    .run(c.title, c.purpose, c.meeting_at, c.location, c.branch_id, c.ack_deadline, id);
}

export function cleanItems(items: NoticeItem[]): NoticeItem[] {
  if (items.length > MAX_ITEMS) throw new PolicyError("too_many_items");
  return items.map((i) => {
    const topic = (i.topic ?? "").trim(), details = (i.details ?? "").trim(), suggestions = (i.suggestions ?? "").trim();
    if (!topic || !details || topic.length > MAX_TOPIC || details.length > MAX_DETAILS || suggestions.length > MAX_SUGGEST) throw new PolicyError("invalid_item");
    return { topic, details, suggestions };
  });
}

/** Replace the whole list of topics (all or nothing). Only while the notice is still scheduled. */
export function saveItems(id: number, items: NoticeItem[]): void {
  const n = load(id);
  if (n.status !== "scheduled") throw new PolicyError(n.status === "published" || n.status === "closed" ? "locked" : "bad_status");
  const cleaned = cleanItems(items);
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM policy_notice_items WHERE notice_id = ?").run(id);
    const ins = db.prepare("INSERT INTO policy_notice_items (notice_id, sort_no, topic, details, suggestions) VALUES (?, ?, ?, ?, ?)");
    cleaned.forEach((it, i) => ins.run(id, i + 1, it.topic, it.details, it.suggestions));
  })();
}

// ── recipients ────────────────────────────────────────────────────────────────

function audience(branchId: number | null): Recipient[] {
  const rows = getDb().prepare(`
    SELECT u.id AS userId, ${sqlNameWithPrefix("u")} AS name, u.line_user_id AS lineUserId FROM users u
     WHERE u.role IN ('staff','admin') AND u.status NOT IN ('disabled','resigned','terminated') AND COALESCE(u.is_test_account,0) = 0
       AND (? IS NULL OR EXISTS (SELECT 1 FROM user_branches ub WHERE ub.user_id = u.id AND ub.branch_id = ?))
     ORDER BY u.display_name`).all(branchId, branchId) as Recipient[];
  return rows;
}

/** Add anyone in the audience who is not on the list yet (never removes). Returns how many were added. */
export function syncRecipients(noticeId: number): number {
  const n = load(noticeId);
  const db = getDb();
  const ins = db.prepare("INSERT OR IGNORE INTO policy_notice_recipients (notice_id, user_id, added_at) VALUES (?, ?, ?)");
  let added = 0;
  db.transaction(() => { for (const r of audience(n.branchId)) if (ins.run(noticeId, r.userId, nowIso()).changes) added++; })();
  return added;
}

export function recipientsOf(noticeId: number, only: "all" | "unacked" = "all"): Recipient[] {
  return getDb().prepare(`
    SELECT u.id AS userId, ${sqlNameWithPrefix("u")} AS name, u.line_user_id AS lineUserId
      FROM policy_notice_recipients r JOIN users u ON u.id = r.user_id
     WHERE r.notice_id = ? ${only === "unacked" ? "AND r.acked_at IS NULL" : ""} ORDER BY u.display_name`).all(noticeId) as Recipient[];
}

// ── status transitions ────────────────────────────────────────────────────────

/** Announce the meeting. Allowed while scheduled; may be repeated (e.g. after a reschedule). */
export function inviteMeeting(id: number): Recipient[] {
  const n = load(id);
  if (n.status !== "scheduled") throw new PolicyError("bad_status");
  if (!n.meetingAt) throw new PolicyError("invalid_meeting_at");
  syncRecipients(id);
  const db = getDb();
  const now = nowIso();
  db.prepare("UPDATE policy_notices SET invited_at = COALESCE(invited_at, ?) WHERE id = ?").run(now, id);
  db.prepare("UPDATE policy_notice_recipients SET invite_sent_at = ? WHERE notice_id = ?").run(now, id);
  return recipientsOf(id);
}

/** Send the post-meeting letter for acknowledgement. Locks the content. */
export function publish(id: number): Recipient[] {
  const n = load(id);
  if (n.status !== "scheduled") throw new PolicyError("bad_status");
  if (listItems(id).length === 0) throw new PolicyError("no_items");
  syncRecipients(id);
  const db = getDb();
  const now = nowIso();
  db.transaction(() => {
    db.prepare("UPDATE policy_notices SET status = 'published', published_at = ? WHERE id = ?").run(now, id);
    db.prepare("UPDATE policy_notice_recipients SET letter_sent_at = ? WHERE notice_id = ?").run(now, id);
  })();
  return recipientsOf(id);
}

export function remindPending(id: number): Recipient[] {
  const n = load(id);
  if (n.status !== "published") throw new PolicyError("bad_status");
  syncRecipients(id);   // employees who joined after the letter went out get it with the reminder
  const list = recipientsOf(id, "unacked");
  const now = nowIso();
  getDb().prepare("UPDATE policy_notice_recipients SET last_reminded_at = ?, letter_sent_at = COALESCE(letter_sent_at, ?) WHERE notice_id = ? AND acked_at IS NULL").run(now, now, id);
  return list;
}

export function closeNotice(id: number): void {
  const n = load(id);
  if (n.status !== "published") throw new PolicyError("bad_status");
  getDb().prepare("UPDATE policy_notices SET status = 'closed', closed_at = ? WHERE id = ?").run(nowIso(), id);
}

export function cancelNotice(id: number): void {
  const n = load(id);
  if (n.status !== "scheduled") throw new PolicyError("bad_status");
  getDb().prepare("UPDATE policy_notices SET status = 'cancelled' WHERE id = ?").run(id);
}

// ── acknowledgement ───────────────────────────────────────────────────────────

/** Record "รับทราบ". Idempotent: a second press keeps the first timestamp. */
export function acknowledge(noticeId: number, userId: number): { ackedAt: string; already: boolean } {
  const n = load(noticeId);
  if (n.status === "scheduled" || n.status === "cancelled") throw new PolicyError("not_published");
  if (n.status === "closed") throw new PolicyError("bad_status");
  const db = getDb();
  const row = db.prepare("SELECT acked_at FROM policy_notice_recipients WHERE notice_id = ? AND user_id = ?").get(noticeId, userId) as { acked_at: string | null } | undefined;
  if (!row) throw new PolicyError("not_recipient");
  if (row.acked_at) return { ackedAt: row.acked_at, already: true };
  const at = nowIso();
  const r = db.prepare("UPDATE policy_notice_recipients SET acked_at = ? WHERE notice_id = ? AND user_id = ? AND acked_at IS NULL").run(at, noticeId, userId);
  if (!r.changes) {
    const again = db.prepare("SELECT acked_at FROM policy_notice_recipients WHERE notice_id = ? AND user_id = ?").get(noticeId, userId) as { acked_at: string };
    return { ackedAt: again.acked_at, already: true };
  }
  return { ackedAt: at, already: false };
}

// ── read models ───────────────────────────────────────────────────────────────

export type AdminNoticeSummary = NoticeRow & { recipientCount: number; ackedCount: number };

export function listForAdmin(): AdminNoticeSummary[] {
  const rows = getDb().prepare(`${SELECT_NOTICE} ORDER BY n.created_at DESC, n.id DESC`).all() as RawNotice[];
  const counts = getDb().prepare("SELECT notice_id AS id, COUNT(*) AS total, SUM(CASE WHEN acked_at IS NOT NULL THEN 1 ELSE 0 END) AS acked FROM policy_notice_recipients GROUP BY notice_id").all() as Array<{ id: number; total: number; acked: number }>;
  const byId = new Map(counts.map((c) => [c.id, c]));
  return rows.map((r) => ({ ...toRow(r), recipientCount: byId.get(r.id)?.total ?? 0, ackedCount: byId.get(r.id)?.acked ?? 0 }));
}

export type AdminAckRow = { userId: number; name: string; ackedAt: string | null; letterSentAt: string | null; lastRemindedAt: string | null };

export function adminDetail(id: number): { notice: NoticeRow; items: NoticeItem[]; recipients: AdminAckRow[] } | null {
  const notice = getNotice(id);
  if (!notice) return null;
  const recipients = getDb().prepare(`
    SELECT r.user_id AS userId, ${sqlNameWithPrefix("u")} AS name, r.acked_at AS ackedAt, r.letter_sent_at AS letterSentAt, r.last_reminded_at AS lastRemindedAt
      FROM policy_notice_recipients r JOIN users u ON u.id = r.user_id
     WHERE r.notice_id = ? ORDER BY (r.acked_at IS NULL) DESC, u.display_name`).all(id) as AdminAckRow[];
  return { notice, items: listItems(id), recipients };
}

export type StaffNotice = {
  id: number; title: string; purpose: string; meetingAt: string | null; location: string; status: NoticeStatus;
  ackDeadline: string | null; publishedAt: string | null; ackedAt: string | null; items: NoticeItem[] | null;
};

/** What one employee may see: meeting notices they were invited to, and letters that were sent. Never other people's data. */
export function listForUser(userId: number): StaffNotice[] {
  const rows = getDb().prepare(`
    SELECT n.id, n.title, n.purpose, n.meeting_at, n.location, n.status, n.ack_deadline, n.published_at, r.acked_at
      FROM policy_notice_recipients r JOIN policy_notices n ON n.id = r.notice_id
     WHERE r.user_id = ? AND (n.status IN ('published','closed') OR (n.status = 'scheduled' AND r.invite_sent_at IS NOT NULL))
     ORDER BY (n.status = 'published' AND r.acked_at IS NULL) DESC, COALESCE(n.published_at, n.created_at) DESC, n.id DESC`).all(userId) as Array<{
    id: number; title: string; purpose: string; meeting_at: string | null; location: string; status: NoticeStatus; ack_deadline: string | null; published_at: string | null; acked_at: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id, title: r.title, purpose: r.purpose, meetingAt: r.meeting_at, location: r.location, status: r.status,
    ackDeadline: r.ack_deadline, publishedAt: r.published_at, ackedAt: r.acked_at,
    items: r.status === "scheduled" ? null : listItems(r.id)
  }));
}

export function pendingAckCount(userId: number): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM policy_notice_recipients r JOIN policy_notices n ON n.id = r.notice_id
    WHERE r.user_id = ? AND n.status = 'published' AND r.acked_at IS NULL`).get(userId) as { n: number }).n;
}
