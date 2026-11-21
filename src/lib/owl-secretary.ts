// นกฮูกเลขา (owner 2026-11-21): the owner tags นกฮูก in a LINE group and it answers from the system.
// Phase A is read-only. Rules, all enforced here in code (never left to the model):
//  - the owner may ask anything; an admin the owner granted (by tagging them in the group) may ask people
//    matters only — never money (owner 2026-11-21);
//  - nothing is read or answered unless นกฮูก is tagged (the webhook passes `mentionedSelf`);
//  - everyone else gets one polite refusal; granting / group on-off stay with the owner;
//  - a group works only after the owner enabled it from inside that group;
//  - changing anything (approve / reject …) is refused for now;
//  - a daily cap on questions limits AI spend.

import { getDb } from "./db";
import { askOwl, OwlAiError, owlAiEnabled } from "./owl-ai";
import { logOwlUsage } from "./owl-data";

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

// A command to change something starts a word with the verb ("อนุมัติ L-0001"); "รออนุมัติ" / "ที่อนุมัติแล้ว" are questions.
// A miss here is harmless: the AI only has read-only tools and is told it cannot approve.
const WRITE_WORDS = /(^|\s)(ช่วย|กรุณา|ให้)?\s*(ไม่อนุมัติ|อนุมัติ|ปฏิเสธ|ยกเลิกใบลา|approve|reject)(?!แล้ว)/i;

export const HELP_TEXT = "นกฮูกพร้อมช่วยครับ ลองพิมพ์ เช่น\n• @นกฮูก สรุปคำขอลาที่รออนุมัติ\n• @นกฮูก คำขอที่ยังรอดำเนินการมีอะไรบ้าง\n• @นกฮูก ค่าใช้จ่ายเดือนนี้เท่าไหร่\nตอนนี้นกฮูกอ่านข้อมูลให้ได้อย่างเดียว การอนุมัติทำที่หน้าเว็บครับ";

/**
 * Handle one text message from a group. Returns the reply text, or null to stay silent.
 * `ask` is injectable for tests.
 */
export async function handleGroupMessage(a: {
  groupId: string; lineUserId?: string; text: string; mentionedSelf: boolean;
  others?: string[];
  ask?: (q: string, scope: "all" | "hr") => Promise<{ answer: string; model: string; inputTokens: number; outputTokens: number }>;
}): Promise<string | null> {
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
  if (WRITE_WORDS.test(text)) return "ตอนนี้นกฮูกอนุมัติหรือเปลี่ยนแปลงข้อมูลผ่านกลุ่มยังไม่ได้ครับ อ่านข้อมูลให้ได้อย่างเดียว กรุณาทำที่หน้าเว็บนะครับ";
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
