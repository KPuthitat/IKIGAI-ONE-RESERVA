// AI digest of the anonymous suggestions staff leave while acknowledging a policy notice.
// Single-shot Anthropic call (raw fetch, no tools), same key/model settings as the other AI features.
// The model only reorganises what staff wrote; it is told not to guess who wrote anything.
import { getSystemSettings } from "./db";
import { DEFAULT_OWL_AI_MODEL, owlAiModel } from "./owl-ai-models";
import { getNotice, listItems, listSuggestions, saveAiSummary } from "./policy-notices";

const API_URL = "https://api.anthropic.com/v1/messages";

export class SuggestionAiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

const SYSTEM = [
  "คุณคือผู้ช่วยสรุปข้อเสนอแนะของพนักงานให้ทีมบริหารธุรกิจคลินิกและร้านอาหารในไทย",
  "พนักงานเขียนข้อเสนอแนะแบบไม่ระบุชื่อหลังอ่านประกาศนโยบายฉบับหนึ่ง",
  "งานของคุณ: จัดกลุ่มข้อเสนอแนะตามประเด็น ใช้ภาษาไทย กระชับ ไม่แต่งข้อมูลเพิ่ม อ้างเฉพาะสิ่งที่พนักงานเขียน",
  "ห้ามเดาหรือพยายามระบุว่าใครเป็นผู้เขียน และไม่ต้องคัดลอกข้อความที่ระบุตัวบุคคลได้ชัดเจน ให้ย่อเป็นสาระแทน",
  "ตอบเป็น markdown โครงนี้เท่านั้น (ไม่หุ้มด้วย ```):",
  "### ภาพรวม  — 2-3 บรรทัด: มีข้อเสนอกี่ข้อ ส่วนใหญ่เกี่ยวกับอะไร และน้ำเสียงโดยรวม",
  "### ประเด็นที่พบ  — แต่ละประเด็นเป็นหัวข้อย่อย (#### ชื่อประเด็น (จำนวนข้อที่กล่าวถึง)) ตามด้วยสรุปสาระ 1-3 บรรทัด เรียงจากที่ถูกพูดถึงมากไปน้อย",
  "### ข้อที่ควรพิจารณาปรับ  — ข้อเสนอที่ทำได้จริงและมีน้ำหนัก เป็น bullet",
  "### ข้อกังวลหรือความเข้าใจคลาดเคลื่อน  — สิ่งที่ควรชี้แจงเพิ่ม (ถ้ามี ไม่มีให้เขียนว่า ไม่พบ)"
].join("\n");

export async function summarizeSuggestions(noticeId: number): Promise<string> {
  const s = getSystemSettings();
  if (!s.owl_ai_enabled) throw new SuggestionAiError("disabled", "AI ปิดอยู่ — เปิดได้ที่ตั้งค่าระบบ");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new SuggestionAiError("no_key", "ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์");
  const n = getNotice(noticeId);
  if (!n) throw new SuggestionAiError("not_found", "ไม่พบประกาศ");
  const list = listSuggestions(noticeId);
  if (list.length === 0) throw new SuggestionAiError("no_suggestions", "ยังไม่มีข้อเสนอแนะให้สรุป");

  const topics = listItems(noticeId).map((i, k) => `${k + 1}. ${i.topic}`).join("\n");
  const userMsg = [
    `ประกาศ: ${n.title}`,
    n.purpose ? `วัตถุประสงค์: ${n.purpose}` : "",
    topics ? `หัวข้อในประกาศ:\n${topics}` : "",
    `\nข้อเสนอแนะจากพนักงาน (${list.length} ข้อ):`,
    list.map((x, i) => `${i + 1}. ${x.body}`).join("\n")
  ].filter(Boolean).join("\n");

  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: owlAiModel(s.owl_ai_model ?? DEFAULT_OWL_AI_MODEL).id, max_tokens: 3000, system: SYSTEM, messages: [{ role: "user", content: userMsg }] })
    });
  } catch { throw new SuggestionAiError("network", "เชื่อมต่อบริการ AI ไม่ได้ ลองใหม่อีกครั้ง"); }
  if (!res.ok) {
    if (res.status === 401) throw new SuggestionAiError("bad_key", "API key ไม่ถูกต้อง");
    if (res.status === 429) throw new SuggestionAiError("rate_limit", "เรียกใช้ถี่เกินไป รอสักครู่");
    throw new SuggestionAiError("api_error", `บริการ AI ขัดข้อง (${res.status})`);
  }
  const json = await res.json().catch(() => null) as { content?: Array<{ type: string; text?: string }> } | null;
  const text = (json?.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
  if (!text) throw new SuggestionAiError("empty", "AI ไม่ได้ส่งผลสรุปกลับมา");
  saveAiSummary(noticeId, text);
  return text;
}
