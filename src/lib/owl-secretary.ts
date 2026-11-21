// นกฮูกเลขา (owner 2026-11-21): the owner tags นกฮูก in a LINE group and it answers from the system.
// Phase A reads; phase B decides leave requests (approve / reject) behind a confirm button. Rules, all enforced here in code (never left to the model):
//  - the owner may ask anything; an admin the owner granted (by tagging them in the group) may ask people
//    matters only — never money (owner 2026-11-21);
//  - nothing is read or answered unless นกฮูก is tagged (the webhook passes `mentionedSelf`);
//  - everyone else gets one polite refusal; granting / group on-off stay with the owner;
//  - a group works only after the owner enabled it from inside that group;
//  - leave decisions: the command only prepares a confirm card; the person who gave it must press the button
//    (signed, 5 minutes, same LINE account) and the web rules (branch, pending, approval tier) are re-checked;
//  - a daily cap on questions limits AI spend.

import crypto from "node:crypto";
import { getDb, logPersonaAction } from "./db";
import { applyLeaveDecision, checkLeaveDecision, type Actor, type Decision } from "./leave-decide";
import { askOwl, OwlAiError, owlAiEnabled } from "./owl-ai";
import { LEAVE_LABEL, logOwlUsage } from "./owl-data";

export const DAILY_CAP = 40;
const LOG_PREFIX = "[LINE กลุ่ม] ";

export type Mentionee = { index?: number; length?: number; type?: string; isSelf?: boolean };

/** True when the message tags this bot. */
export const mentionsSelf = (m?: { mentionees?: Mentionee[] }) => !!m?.mentionees?.some((x) => x.isSelf);

/** LINE user ids of the other people tagged in the message. */
export const otherMentionIds = (m?: { mentionees?: Array<Mentionee & { userId?: string }> }): string[] =>
  (m?.mentionees ?? []).filter((x) => !x.isSelf && x.type === "user" && x.userId).map((x) => x.userId as string);

/** The text without the tag(s) of this bot. */
export function stripSelfMention(text: string, m?: { mentionees?: Mentionee[] }): string {
  const spans = (m?.mentionees ?? []).filter((x) => x.isSelf && typeof x.index === "number" && typeof x.length === "number")
    .map((x) => [x.index as number, (x.index as number) + (x.length as number)] as const).sort((a, b) => b[0] - a[0]);
  let out = text;
  for (const [s, e] of spans) out = out.slice(0, s) + out.slice(e);
  return out.replace(/\s+/g, " ").trim();
}

type Owner = { id: number };
type Who = { id: number; role: string };
function whoIs(lineUserId: string | undefined): Who | null {
  if (!lineUserId) return null;
  return (getDb().prepare("SELECT id, role FROM users WHERE line_user_id = ? AND role IN ('super_admin','admin') AND status NOT IN ('disabled','resigned','terminated')").get(lineUserId) as Who | undefined) ?? null;
}
const isGranted = (userId: number) => !!getDb().prepare("SELECT 1 FROM owl_secretary_users WHERE user_id = ?").get(userId);
function ownerOf(lineUserId: string | undefined): Owner | null {
  if (!lineUserId) return null;
  return (getDb().prepare("SELECT id FROM users WHERE line_user_id = ? AND role = 'super_admin' AND status NOT IN ('disabled','resigned','terminated')").get(lineUserId) as Owner | undefined) ?? null;
}
const isEnabled = (groupId: string) => !!getDb().prepare("SELECT 1 FROM owl_secretary_groups WHERE group_id = ?").get(groupId);
const askedToday = () => (getDb().prepare("SELECT COUNT(*) n FROM owl_ai_usage WHERE question LIKE ? AND substr(created_at,1,10) = date('now')").get(`${LOG_PREFIX}%`) as { n: number }).n;

// A command to change something starts a word with the verb ("อนุมัติ L20261101"); "รออนุมัติ" / "ที่อนุมัติแล้ว" are questions.
// A miss here is harmless: the AI only has read-only tools and is told it cannot approve.
const WRITE_WORDS = /(^|\s)(ช่วย|กรุณา|ให้)?\s*(ไม่อนุมัติ|อนุมัติ|ปฏิเสธ|ยกเลิกใบลา|approve|reject)(?!แล้ว)/i;
const REF_RE = /\bL-?(\d{6,12})\b/i;

export type GroupReply = string | { flex: { type: "flex"; altText: string; contents: unknown } } | null;

// ── leave decisions with a confirm button ────────────────────────────────

const CONFIRM_TTL_SEC = 300;
const sign = (payload: string, secret: string) => crypto.createHmac("sha256", secret).update(payload).digest("hex").slice(0, 20);
/** postback data: owl_leave:<y|n>:<id>:<a|r>:<expiry>:<issuer LINE id>:<sig>  (y = confirm, n = cancel; a = approve, r = reject) */
export function confirmData(kind: "y" | "n", id: number, decision: "a" | "r", lineUserId: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const body = `owl_leave:${kind}:${id}:${decision}:${nowSec + CONFIRM_TTL_SEC}:${lineUserId}`;
  return `${body}:${sign(body, secret)}`;
}

/** Who may decide leave from the group: the owner, or an admin the owner granted. Same branch/tier rules as the web. */
function actorOf(lineUserId: string | undefined): Actor | null {
  const w = whoIs(lineUserId);
  if (!w || (w.role !== "super_admin" && !(w.role === "admin" && isGranted(w.id)))) return null;
  const db = getDb();
  const branchIds = w.role === "super_admin"
    ? (db.prepare("SELECT id FROM branches").all() as Array<{ id: number }>).map((b) => b.id)
    : (db.prepare("SELECT branch_id AS id FROM user_branches WHERE user_id = ?").all(w.id) as Array<{ id: number }>).map((b) => b.id);
  return { id: w.id, role: w.role, branchIds };
}

const ERR_TH: Record<string, (c: { currentStatus?: string; tier?: number }) => string> = {
  not_found: () => "ไม่พบใบลาเลขนี้ครับ",
  branch_forbidden: () => "ใบลานี้เป็นของสาขาที่ท่านไม่ได้ดูแลครับ",
  already_decided: (c) => `ใบลานี้ตัดสินแล้ว (สถานะ ${c.currentStatus ?? "-"}) ครับ`,
  not_in_approval_tier: (c) => `ท่านไม่ได้อยู่ในชั้นที่ ${c.tier} ของสายบังคับบัญชาของใบลานี้ครับ`
};

function leaveInfo(id: number) {
  return getDb().prepare(`SELECT l.ref_no AS ref, COALESCE(NULLIF(u.nickname_th,''), u.display_name) AS name, l.type, l.date_from AS dateFrom, l.date_to AS dateTo, l.days, l.current_tier AS tier
    FROM leave_requests l JOIN users u ON u.id = l.user_id WHERE l.id = ?`).get(id) as { ref: string; name: string; type: string; dateFrom: string; dateTo: string; days: number; tier: number | null };
}

/** The command "อนุมัติ L…" / "ไม่อนุมัติ L…": validate, then ask for a confirmation — nothing is changed here. */
function prepareDecision(text: string, lineUserId: string | undefined, secret: string): GroupReply {
  const actor = actorOf(lineUserId);
  if (!actor || !lineUserId) return "คำสั่งผ่านกลุ่มนี้สั่งได้เฉพาะผู้ที่เจ้าของให้สิทธิ์ครับ";
  const m = text.match(REF_RE);
  if (!m || /ยกเลิกใบลา/.test(text)) return "ตอนนี้นกฮูกอนุมัติ/ไม่อนุมัติได้เฉพาะใบลา และต้องระบุเลขอ้างอิง เช่น “@นกฮูก อนุมัติ L20261101” (ดูเลขได้จากการสรุปคำขอลา) ครับ";
  const reject = /(ไม่อนุมัติ|ปฏิเสธ|reject)/i.test(text);
  const row = getDb().prepare("SELECT id FROM leave_requests WHERE ref_no = ?").get(`L${m[1]}`) as { id: number } | undefined;
  if (!row) return ERR_TH.not_found({});
  const chk = checkLeaveDecision(row.id, actor);
  if (!chk.ok) return ERR_TH[chk.error](chk);
  const info = leaveInfo(row.id);
  const verb = reject ? "ไม่อนุมัติ" : "อนุมัติ";
  const dec = reject ? "r" : "a";
  const lines = [`${info.name}`, `${LEAVE_LABEL[info.type] ?? info.type} · ${info.dateFrom}${info.dateTo !== info.dateFrom ? ` ถึง ${info.dateTo}` : ""} · ${info.days} วัน`,
    ...(!reject && info.tier === 1 ? ["ชั้นที่ 1: อนุมัติแล้วจะส่งต่อชั้นที่ 2 (ยังไม่อนุมัติขั้นสุดท้าย)"] : []),
    "กดยืนยันภายใน 5 นาที เฉพาะผู้สั่งเท่านั้นที่กดได้"];
  return { flex: {
    type: "flex", altText: `ยืนยัน${verb}ใบลา ${info.ref}`,
    contents: {
      type: "bubble", size: "kilo",
      header: { type: "box", layout: "vertical", backgroundColor: reject ? "#7f1d1d" : "#14532d", paddingAll: "14px", contents: [
        { type: "text", text: `ยืนยัน${verb}ใบลา ${info.ref}`, color: "#ffffff", weight: "bold", size: "md", wrap: true } ] },
      body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "14px", contents: lines.map((t, i) => ({ type: "text", text: t, size: i === 0 ? "md" : "sm", weight: i === 0 ? "bold" : "regular", color: "#1a1a2e", wrap: true })) },
      footer: { type: "box", layout: "horizontal", spacing: "sm", contents: [
        { type: "button", style: "secondary", action: { type: "postback", label: "ยกเลิก", data: confirmData("n", row.id, dec, lineUserId, secret) } },
        { type: "button", style: "primary", color: reject ? "#b91c1c" : "#15803d", action: { type: "postback", label: `ยืนยัน${verb}`, data: confirmData("y", row.id, dec, lineUserId, secret) } } ] }
    }
  } };
}

/** The button press. Returns the text to post in the group, or null to stay silent. */
export function handleConfirmPostback(a: { data: string; groupId: string; lineUserId?: string; secret: string; nowSec?: number }): string | null {
  const p = a.data.split(":");
  if (p.length !== 7 || p[0] !== "owl_leave") return null;
  const [, kind, idStr, dec, expStr, issuer, sig] = p;
  const good = sign(p.slice(0, 6).join(":"), a.secret);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;   // forged or altered
  if (!a.lineUserId || a.lineUserId !== issuer) return null;                  // only the person who gave the command may press
  if (!isEnabled(a.groupId)) return null;
  if ((a.nowSec ?? Math.floor(Date.now() / 1000)) > Number(expStr)) return "ปุ่มยืนยันหมดอายุแล้วครับ (เกิน 5 นาที) สั่งใหม่ได้เลย";
  if (kind === "n") return "ยกเลิกคำสั่งแล้วครับ";
  if (kind !== "y") return null;
  const actor = actorOf(a.lineUserId);
  if (!actor) return "สิทธิ์สั่งงานผ่านกลุ่มนี้ถูกถอนแล้วครับ";
  const id = Number(idStr);
  const chk = checkLeaveDecision(id, actor);                                   // re-checked at press time
  if (!chk.ok) return ERR_TH[chk.error](chk);
  const decision: Decision = dec === "r" ? "rejected" : "approved";
  const info = leaveInfo(id);
  const res = applyLeaveDecision(id, chk.row, actor, decision);
  logPersonaAction(actor.id, `leave.${decision}.line_group`, id);
  if (res.status === "pending") return `อนุมัติชั้นที่ 1 ของใบลา ${info.ref} (${info.name}) แล้ว ส่งต่อชั้นที่ 2 ครับ ยังไม่อนุมัติขั้นสุดท้าย`;
  return res.status === "approved" ? `อนุมัติใบลา ${info.ref} ของ ${info.name} แล้วครับ ระบบแจ้งพนักงานแล้ว` : `ไม่อนุมัติใบลา ${info.ref} ของ ${info.name} แล้วครับ ระบบแจ้งพนักงานแล้ว`;
}

export const HELP_TEXT = "นกฮูกพร้อมช่วยครับ ลองพิมพ์ เช่น\n• @นกฮูก สรุปคำขอลาที่รออนุมัติ\n• @นกฮูก อนุมัติ L20261101 (หรือ ไม่อนุมัติ L20261101)\n• @นกฮูก คำขอที่ยังรอดำเนินการมีอะไรบ้าง\nการอนุมัติ/ไม่อนุมัติจะมีปุ่มให้กดยืนยันก่อนเสมอ ตอนนี้ทำได้เฉพาะใบลาครับ";

/**
 * Handle one text message from a group. Returns the reply text, or null to stay silent.
 * `ask` is injectable for tests.
 */
export async function handleGroupMessage(a: {
  groupId: string; lineUserId?: string; text: string; mentionedSelf: boolean;
  others?: string[];
  secret?: string;
  ask?: (q: string, scope: "all" | "hr") => Promise<{ answer: string; model: string; inputTokens: number; outputTokens: number }>;
}): Promise<GroupReply> {
  if (!a.mentionedSelf) return null;                         // never react to untagged chatter
  const owner = ownerOf(a.lineUserId);
  const enabled = isEnabled(a.groupId);
  const text = a.text.trim();

  if (/^(เปิดใช้กลุ่มนี้|ตั้งกลุ่มนี้)/.test(text)) {
    if (!owner) return "การตั้งค่านี้ทำได้เฉพาะเจ้าของครับ";
    getDb().prepare("INSERT OR IGNORE INTO owl_secretary_groups (group_id, set_by) VALUES (?, ?)").run(a.groupId, owner.id);
    return enabled ? "กลุ่มนี้เปิดใช้อยู่แล้วครับ" : "เปิดใช้กลุ่มนี้แล้วครับ เจ้าของแท็กนกฮูกสั่งงานได้เลย ตอนนี้อ่านข้อมูลให้ได้อย่างเดียว";
  }
  if (/^(เลิกใช้กลุ่มนี้|ปิดกลุ่มนี้)/.test(text)) {
    if (!owner) return "การตั้งค่านี้ทำได้เฉพาะเจ้าของครับ";
    getDb().prepare("DELETE FROM owl_secretary_groups WHERE group_id = ?").run(a.groupId);
    return "เลิกใช้กลุ่มนี้แล้วครับ";
  }

  if (/^(ให้สิทธิ์|ให้สิทธิ|ถอนสิทธิ์|ถอนสิทธิ|ยกเลิกสิทธิ์)/.test(text)) {
    if (!owner) return "การให้สิทธิ์ทำได้เฉพาะเจ้าของครับ";
    const revoke = /^(ถอน|ยกเลิก)/.test(text);
    const targets = (a.others ?? []).map((l) => whoIs(l)).filter((x): x is Who => !!x && x.role === "admin");
    if (targets.length === 0) return "ไม่พบผู้ที่แท็ก หรือไม่ใช่ผู้ดูแลระบบ (admin) ที่ผูก LINE แล้วครับ แท็กชื่อคนนั้นต่อท้ายคำสั่งนะครับ";
    for (const t of targets) {
      if (revoke) getDb().prepare("DELETE FROM owl_secretary_users WHERE user_id = ?").run(t.id);
      else getDb().prepare("INSERT OR IGNORE INTO owl_secretary_users (user_id, granted_by) VALUES (?, ?)").run(t.id, owner.id);
    }
    return revoke ? `ถอนสิทธิ์แล้ว ${targets.length} คนครับ` : `ให้สิทธิ์แล้ว ${targets.length} คนครับ ผู้ที่ได้สิทธิ์ถามเรื่องงานบุคคลได้ ส่วนการเงินถามได้เฉพาะเจ้าของ`;
  }

  // the owner may ask anything; an admin the owner granted may ask people matters only
  const caller = owner ?? (() => { const w = whoIs(a.lineUserId); return w && w.role === "admin" && isGranted(w.id) ? w : null; })();
  const scope: "all" | "hr" = owner ? "all" : "hr";
  if (!enabled) return owner ? "กลุ่มนี้ยังไม่ได้เปิดใช้ครับ พิมพ์ “@นกฮูก เปิดใช้กลุ่มนี้” เพื่อเปิด" : null;
  if (!caller) return "คำสั่งผ่านกลุ่มนี้สั่งได้เฉพาะผู้ที่เจ้าของให้สิทธิ์ครับ";

  if (!text) return HELP_TEXT;
  if (WRITE_WORDS.test(text)) return prepareDecision(text, a.lineUserId, a.secret ?? "");
  if (text.length > 600) return "ข้อความยาวเกินไปครับ ช่วยพิมพ์ให้สั้นลงหน่อย";
  if (!(a.ask || owlAiEnabled())) return "นกฮูก (AI) ยังไม่ได้เปิดใช้งานครับ เปิดได้ที่ตั้งค่าระบบ";
  if (askedToday() >= DAILY_CAP) return `วันนี้ถามครบ ${DAILY_CAP} ครั้งแล้วครับ พรุ่งนี้ถามต่อได้`;

  try {
    const r = await (a.ask ?? ((q: string, sc: "all" | "hr") => askOwl(q, { surface: "group", scope: sc })))(text, scope);
    logOwlUsage({ model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, question: LOG_PREFIX + text, userId: caller.id });
    return r.answer.length > 4500 ? r.answer.slice(0, 4400) + "\n…(ตัดข้อความ)" : r.answer;
  } catch (e) {
    return e instanceof OwlAiError ? e.message : "นกฮูกตอบไม่สำเร็จ ลองใหม่อีกครั้งครับ";
  }
}
