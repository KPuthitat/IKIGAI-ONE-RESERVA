// AI สรุปประชุมผู้บริหาร (owner 2026-09-02). After the attendees submit their
// minutes, an admin asks the AI to (1) สรุปรายงานการประชุม, (2) สร้างเช็คลิสต์
// ติดตามแผนการดำเนินงานสัปดาห์หน้า, (3) โน้ตเรื่องที่ทำไปแล้ว เทียบกับประเด็นคงค้าง
// จากสัปดาห์ก่อน, และ (4) สรุปประเด็นคงค้างที่ยังไม่เสร็จไปคุยต่อสัปดาห์หน้า.
//
// Single-shot Anthropic call (raw fetch, no tools) — reuses น้องฮูก's key/model
// settings. Every input is the attendees' own text; the model only reorganises
// and summarises it.

import { getDb, getSystemSettings } from "./db";
import { DEFAULT_OWL_AI_MODEL, owlAiModel } from "./owl-ai-models";

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export class MeetingAiError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export type MeetingAiResult = {
  summary: string;                       // markdown สรุปการประชุม
  checklist: Array<{ item: string; owner?: string }>;  // ติดตามสัปดาห์หน้า
  carryover: Array<{ item: string }>;    // ประเด็นคงค้าง
};

const SYSTEM = [
  "คุณคือผู้ช่วยสรุปการประชุมผู้บริหารของธุรกิจคลินิก+ร้านอาหารในไทย.",
  "รับรายงานการประชุมจากผู้เข้าร่วมแต่ละคน (วาระ/รายละเอียด/ข้อเสนอแนะ/แผนการจัดการ)",
  "และประเด็นคงค้างจากสัปดาห์ก่อน (ถ้ามี).",
  "งานของคุณ: รวบรวมและสรุปให้กระชับ ใช้ภาษาไทย ไม่แต่งข้อมูลเพิ่มเอง อ้างเฉพาะสิ่งที่มีในรายงาน.",
  "ตอบเป็น JSON เท่านั้น (ไม่มีข้อความอื่นหุ้ม) รูปแบบ:",
  '{"summary": "<สรุปการประชุมแบบ markdown>", "checklist": [{"item":"<สิ่งที่ต้องติดตามสัปดาห์หน้า>","owner":"<ผู้รับผิดชอบถ้าระบุ>"}], "carryover": [{"item":"<ประเด็นที่ยังไม่เสร็จ ยกไปคุยสัปดาห์หน้า>"}]}',
  "ใน summary ให้มีหัวข้อ: ภาพรวม, มติ/สิ่งที่ตกลง, เรื่องที่ดำเนินการไปแล้ว (เทียบประเด็นคงค้างเดิม), และข้อเสนอแนะเด่น."
].join(" ");

function resolvedModel(): string {
  return owlAiModel(getSystemSettings().owl_ai_model ?? DEFAULT_OWL_AI_MODEL).id;
}

function extractJson(text: string): MeetingAiResult {
  // Be forgiving: the model may wrap JSON in prose or a ```json fence.
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  let obj: unknown;
  try { obj = JSON.parse(t); } catch { throw new MeetingAiError("parse", "อ่านผลสรุปจาก AI ไม่ได้"); }
  const o = obj as Record<string, unknown>;
  const summary = typeof o.summary === "string" ? o.summary : "";
  const checklist = Array.isArray(o.checklist)
    ? o.checklist.map((c) => {
        const cc = c as Record<string, unknown>;
        return { item: String(cc.item ?? "").trim(), owner: cc.owner ? String(cc.owner).trim() : undefined };
      }).filter((c) => c.item.length > 0)
    : [];
  const carryover = Array.isArray(o.carryover)
    ? o.carryover.map((c) => ({ item: String((c as Record<string, unknown>).item ?? "").trim() })).filter((c) => c.item.length > 0)
    : [];
  return { summary, checklist, carryover };
}

// Gather every attendee's minutes for a meeting as a readable block.
function collectMinutes(meetingId: number): { title: string; date: string; block: string; count: number } | null {
  const db = getDb();
  const m = db.prepare("SELECT title, meeting_date FROM exec_meetings WHERE id = ?")
    .get(meetingId) as { title: string; meeting_date: string } | undefined;
  if (!m) return null;
  const rows = db.prepare(`
    SELECT u.display_name, mm.agenda, mm.details, mm.suggestions, mm.action_plan
    FROM exec_meeting_minutes mm
    JOIN users u ON u.id = mm.user_id
    WHERE mm.meeting_id = ?
      AND (TRIM(mm.agenda) <> '' OR TRIM(mm.details) <> '' OR TRIM(mm.suggestions) <> '' OR TRIM(mm.action_plan) <> '')
    ORDER BY u.display_name COLLATE NOCASE
  `).all(meetingId) as Array<{ display_name: string; agenda: string; details: string; suggestions: string; action_plan: string }>;
  const block = rows.map((r, i) => (
    `ผู้เข้าร่วมคนที่ ${i + 1}: ${r.display_name}\n` +
    `- วาระ: ${r.agenda}\n- รายละเอียด: ${r.details}\n- ข้อเสนอแนะ: ${r.suggestions}\n- แผนการจัดการ: ${r.action_plan}`
  )).join("\n\n");
  return { title: m.title, date: m.meeting_date, block, count: rows.length };
}

// The carryover from the most recent EARLIER meeting that has a summary, so the
// AI can note what was already handled and what is still outstanding.
function previousCarryover(meetingId: number, meetingDate: string): string {
  const db = getDb();
  const prev = db.prepare(`
    SELECT ai_carryover FROM exec_meetings
    WHERE id <> ? AND meeting_date <= ? AND ai_carryover IS NOT NULL AND TRIM(ai_carryover) <> ''
    ORDER BY meeting_date DESC, id DESC LIMIT 1
  `).get(meetingId, meetingDate) as { ai_carryover: string } | undefined;
  if (!prev) return "";
  try {
    const arr = JSON.parse(prev.ai_carryover) as Array<{ item: string }>;
    return arr.map((c) => `- ${c.item}`).join("\n");
  } catch { return ""; }
}

export async function summarizeMeeting(meetingId: number): Promise<MeetingAiResult> {
  const s = getSystemSettings();
  if (!s.owl_ai_enabled) throw new MeetingAiError("disabled", "AI ปิดอยู่ — เปิดได้ที่ตั้งค่าระบบ");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new MeetingAiError("no_key", "ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์");

  const mins = collectMinutes(meetingId);
  if (!mins) throw new MeetingAiError("not_found", "ไม่พบการประชุม");
  if (mins.count === 0) throw new MeetingAiError("no_minutes", "ยังไม่มีรายงานการประชุมให้สรุป");

  const carry = previousCarryover(meetingId, mins.date);
  const userMsg = [
    `การประชุม: ${mins.title} (วันที่ ${mins.date})`,
    carry ? `\nประเด็นคงค้างจากสัปดาห์ก่อน:\n${carry}` : "",
    `\nรายงานจากผู้เข้าร่วม:\n${mins.block}`
  ].join("\n");

  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
      body: JSON.stringify({
        model: resolvedModel(), max_tokens: 2000, system: SYSTEM,
        messages: [{ role: "user", content: userMsg }]
      })
    });
  } catch {
    throw new MeetingAiError("network", "เชื่อมต่อบริการ AI ไม่ได้ ลองใหม่อีกครั้ง");
  }
  if (!res.ok) {
    const status = res.status;
    if (status === 401) throw new MeetingAiError("bad_key", "API key ไม่ถูกต้อง");
    if (status === 429) throw new MeetingAiError("rate_limit", "เรียกใช้ถี่เกินไป รอสักครู่");
    throw new MeetingAiError("api_error", `บริการ AI ขัดข้อง (${status})`);
  }
  const json = await res.json().catch(() => null) as { content?: Array<{ type: string; text?: string }> } | null;
  const text = (json?.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
  if (!text.trim()) throw new MeetingAiError("empty", "AI ไม่ได้ส่งผลสรุปกลับมา");

  const result = extractJson(text);
  getDb().prepare(`
    UPDATE exec_meetings
    SET ai_summary = ?, ai_checklist = ?, ai_carryover = ?, summarized_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(result.summary, JSON.stringify(result.checklist), JSON.stringify(result.carryover), meetingId);
  return result;
}
