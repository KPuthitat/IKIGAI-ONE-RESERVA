// AI สรุปประชุมผู้บริหาร (owner 2026-09-02). After the attendees submit their
// minutes, an admin asks the AI to (1) สรุปรายงานการประชุม, (2) สร้างเช็คลิสต์
// ติดตามแผนการดำเนินงานสัปดาห์หน้า, (3) โน้ตเรื่องที่ทำไปแล้ว เทียบกับประเด็นคงค้าง
// จากสัปดาห์ก่อน, และ (4) สรุปประเด็นคงค้างที่ยังไม่เสร็จไปคุยต่อสัปดาห์หน้า.
//
// Single-shot Anthropic call (raw fetch, no tools) — reuses น้องฮูก's key/model
// settings. Every input is the attendees' own text; the model only reorganises
// and summarises it.

import { getDb, getSystemSettings } from "./db";
import { DEFAULT_OWL_AI_MODEL, owlAiModel, owlAiCostBaht } from "./owl-ai-models";
import { itemsFromRow, getMeetingInvitees, type MinutesRow } from "./exec-meetings";

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
  usage?: { in_tokens: number; out_tokens: number; cost_baht: number; model: string };
};

// A delimiter-based reply format — NOT JSON. The summary is long markdown with
// many newlines; embedding it in JSON made the model emit invalid JSON (literal
// newlines inside a string value) and parsing failed every time (owner
// 2026-09-02). Sections are robust to newlines, escaping, and truncation.
const SYSTEM = [
  "คุณคือผู้ช่วยสรุปการประชุมผู้บริหารของธุรกิจคลินิก+ร้านอาหารในไทย.",
  "รับรายงานการประชุมจากผู้เข้าร่วมแต่ละคน (วาระ/รายละเอียด/ข้อเสนอแนะ/แผนการจัดการ/ผู้รับผิดชอบ)",
  "และประเด็นคงค้างจากสัปดาห์ก่อน (ถ้ามี).",
  "งานของคุณ: รวบรวมและสรุปให้กระชับ ใช้ภาษาไทย ไม่แต่งข้อมูลเพิ่มเอง อ้างเฉพาะสิ่งที่มีในรายงาน.",
  "ตอบตามรูปแบบนี้เท่านั้น ห้ามมีข้อความอื่นก่อนหรือหลัง และห้ามหุ้มด้วย ``` :",
  "===SUMMARY===",
  "(สรุปแบบ markdown ให้ละเอียด อ่านแล้วเข้าใจการประชุมครบโดยไม่ต้องดูรายงานดิบ ใช้หัวข้อ ### และ bullet. โครงที่ต้องมี:",
  "### ภาพรวม  — บริบทและประเด็นหลักของการประชุม 2-4 บรรทัด.",
  "### สรุปรายวาระ  — ทุกวาระ หัวข้อละหนึ่งย่อหน้า: สาระสำคัญที่คุย, มติ/ข้อตกลง, และถ้ามีผู้รับผิดชอบ/กำหนดเวลาให้ระบุ.",
  "### เรื่องที่ทำไปแล้ว  — เทียบกับประเด็นคงค้างเดิม (ถ้ามี).",
  "### ข้อเสนอแนะและความเสี่ยง  — ข้อเสนอเด่น และสิ่งที่ต้องระวัง/ติดตาม.)",
  "===CHECKLIST===",
  "(สิ่งที่ต้องติดตามสัปดาห์หน้า ให้ครบทุกงานที่มีในรายงาน บรรทัดละ 1 รายการ ขึ้นต้นด้วย - รูปแบบ: เรื่องที่ต้องทำ :: ผู้รับผิดชอบ  ถ้าไม่มีผู้รับผิดชอบใส่ - )",
  "===CARRYOVER===",
  "(ประเด็นคงค้างที่ยกไปคุยต่อสัปดาห์หน้า บรรทัดละ 1 รายการ ขึ้นต้นด้วย - ถ้าไม่มีให้เว้นว่าง)"
].join("\n");

function resolvedModel(): string {
  return owlAiModel(getSystemSettings().owl_ai_model ?? DEFAULT_OWL_AI_MODEL).id;
}

// Pull one ===NAME=== section's body (up to the next section marker or the end).
function sectionBody(text: string, name: string): string {
  const re = new RegExp(`===\\s*${name}\\s*===([\\s\\S]*?)(?:\\n===\\s*(?:SUMMARY|CHECKLIST|CARRYOVER)\\s*===|$)`, "i");
  const m = re.exec(text);
  return m ? m[1].trim() : "";
}

function bulletLines(body: string): string[] {
  return body.split(/\r?\n/).map((l) => l.replace(/^\s*[-*•]\s*/, "").trim()).filter((l) => l.length > 0);
}

export function parseMeetingAi(text: string): MeetingAiResult {
  const summary = sectionBody(text, "SUMMARY");
  const checklist = bulletLines(sectionBody(text, "CHECKLIST")).map((line) => {
    const [item, owner] = line.split("::").map((x) => x.trim());
    return { item: (item ?? line).trim(), owner: owner && owner !== "-" ? owner : undefined };
  }).filter((c) => c.item.length > 0);
  const carryover = bulletLines(sectionBody(text, "CARRYOVER"))
    .map((item) => ({ item })).filter((c) => c.item.length > 0);

  if (!summary && checklist.length === 0 && carryover.length === 0) {
    // Nothing recognisable came back — log a preview for pm2 diagnosis.
    console.warn("exec-meeting AI: no sections parsed. len=", text.length, "head=", text.slice(0, 400));
    throw new MeetingAiError("parse", "อ่านผลสรุปจาก AI ไม่ได้ — ลองใหม่อีกครั้ง");
  }
  return { summary, checklist, carryover };
}

// Gather every attendee's minutes for a meeting as a readable block.
function collectMinutes(meetingId: number): { title: string; date: string; block: string; count: number } | null {
  const db = getDb();
  const m = db.prepare("SELECT title, meeting_date FROM exec_meetings WHERE id = ?")
    .get(meetingId) as { title: string; meeting_date: string } | undefined;
  if (!m) return null;
  const rows = db.prepare(`
    SELECT u.display_name, mm.items, mm.agenda, mm.details, mm.suggestions, mm.action_plan
    FROM exec_meeting_minutes mm
    JOIN users u ON u.id = mm.user_id
    WHERE mm.meeting_id = ?
    ORDER BY u.display_name COLLATE NOCASE
  `).all(meetingId) as Array<MinutesRow & { display_name: string }>;
  // Name lookup for ผู้รับผิดชอบ (owner_user_ids reference meeting invitees).
  const nameOf = new Map(getMeetingInvitees(meetingId).map((p) => [p.user_id, `${p.title_prefix ? `${p.title_prefix} ` : ""}${p.display_name}`]));
  // Only วาระ that carry actual content — a preset topic left unanswered has
  // nothing to summarise, and feeding dozens of blanks bloats the request and
  // muddies the summary (owner 2026-09-02).
  const people = rows
    .map((r) => ({ name: r.display_name, items: itemsFromRow(r).filter((it) => it.details || it.suggestions || it.action_plan) }))
    .filter((p) => p.items.length > 0);
  const block = people.map((p, i) => {
    const items = p.items.map((it, j) => {
      const owners = it.owner_user_ids.map((uid) => nameOf.get(uid) ?? `#${uid}`).join(", ");
      return `  วาระที่ ${j + 1}: ${it.topic}\n` +
        `  - รายละเอียด: ${it.details}\n  - ข้อเสนอแนะ: ${it.suggestions}\n  - แผนการจัดการ: ${it.action_plan}` +
        (owners ? `\n  - ผู้รับผิดชอบ: ${owners}` : "");
    }).join("\n");
    return `ผู้เข้าร่วมคนที่ ${i + 1}: ${p.name}\n${items}`;
  }).join("\n\n");
  return { title: m.title, date: m.meeting_date, block, count: people.length };
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

// Fast pre-flight checks — run synchronously so the caller can reject a bad
// request immediately (before kicking off the slow background summary).
export function precheckSummary(meetingId: number): void {
  if (!getSystemSettings().owl_ai_enabled) throw new MeetingAiError("disabled", "AI ปิดอยู่ — เปิดได้ที่ตั้งค่าระบบ");
  if (!process.env.ANTHROPIC_API_KEY) throw new MeetingAiError("no_key", "ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์");
  const mins = collectMinutes(meetingId);
  if (!mins) throw new MeetingAiError("not_found", "ไม่พบการประชุม");
  if (mins.count === 0) throw new MeetingAiError("no_minutes", "ยังไม่มีรายงานการประชุมให้สรุป");
}

// Mark the background summary's state so the polling UI can react.
export function setSummaryStatus(meetingId: number, status: "running" | "done" | "error", error?: string): void {
  getDb().prepare("UPDATE exec_meetings SET ai_status = ?, ai_error = ? WHERE id = ?")
    .run(status, error ?? null, meetingId);
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
        // Big meetings (many วาระ × many people) produce a long summary; a small
        // cap truncates the JSON mid-output and breaks parsing (owner 2026-09-02).
        model: resolvedModel(), max_tokens: 8000, system: SYSTEM,
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
  const json = await res.json().catch(() => null) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  } | null;
  const text = (json?.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
  if (!text.trim()) throw new MeetingAiError("empty", "AI ไม่ได้ส่งผลสรุปกลับมา");

  const result = parseMeetingAi(text);
  const model = resolvedModel();
  const inTok = json?.usage?.input_tokens ?? 0;
  const outTok = json?.usage?.output_tokens ?? 0;
  result.usage = { in_tokens: inTok, out_tokens: outTok, cost_baht: owlAiCostBaht(model, inTok, outTok), model };
  getDb().prepare(`
    UPDATE exec_meetings
    SET ai_summary = ?, ai_checklist = ?, ai_carryover = ?, summarized_at = CURRENT_TIMESTAMP,
        ai_in_tokens = ?, ai_out_tokens = ?, ai_cost_baht = ?, ai_model = ?,
        ai_status = 'done', ai_error = NULL
    WHERE id = ?
  `).run(result.summary, JSON.stringify(result.checklist), JSON.stringify(result.carryover),
    inTok, outTok, result.usage.cost_baht, model, meetingId);
  return result;
}
