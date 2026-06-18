// ── ACCOUNTA — bill OCR (server-only) ──────────────────────────────
// Calls the Anthropic Messages API directly via fetch (no SDK dependency
// — keeps the 1 GB droplet lean). Reads one bill/receipt image and returns
// structured fields to PRE-FILL the add form; the human always confirms
// before saving. Disabled unless the owner flips accounta_ocr_enabled AND
// ANTHROPIC_API_KEY is set. "เน้นถูกต้อง ประหยัด" (owner 2026-06-16).

import { getSystemSettings } from "./db";
import { DEFAULT_OCR_MODEL, ocrModel, type OcrBillResult } from "./accounta";

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export class OcrError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Build the extraction prompt. When `categories` is given, the model must
 *  pick `category` from that exact list (or null) so the result maps onto the
 *  owner's ผังหมวด in accounta_categories — no free-text drift (owner
 *  2026-06-18, จัดหมวดอัตโนมัติ). Without a list it falls back to a free guess. */
function buildPrompt(categories?: string[]): string {
  const cats = (categories ?? []).filter((c) => c.trim());
  const categoryRule = cats.length
    ? `เลือกชื่อหมวดที่ตรงที่สุด "จากรายการนี้เท่านั้น" และตอบเป็นชื่อให้ตรงเป๊ะทุกตัวอักษร — ` +
      `ถ้าไม่มีหมวดไหนตรงเลยให้ใส่ null (ห้ามสร้างหมวดใหม่เอง):\n` +
      cats.map((c) => `  - ${c}`).join("\n")
    : `เดาหมวดหมู่สั้นๆ เช่น วัตถุดิบ/เวชภัณฑ์, ค่าขนส่ง, ซอฟต์แวร์/ระบบ`;

  return `คุณเป็นผู้ช่วยคีย์บิลค่าใช้จ่ายของคลินิก อ่านรูปบิล/ใบเสร็จ/ใบกำกับภาษีนี้แล้วดึงข้อมูลออกมา
ตอบกลับเป็น JSON อย่างเดียว (ไม่มีข้อความอื่น ไม่มี markdown) ตามรูปแบบนี้เป๊ะ:
{
  "vendor_name": string|null,        // ชื่อผู้ขาย/ร้านค้า — เฉพาะที่พิมพ์อยู่บนบิลจริงเท่านั้น
  "tax_id": string|null,             // เลขประจำตัวผู้เสียภาษี 13 หลัก ถ้ามี
  "bill_date": string|null,          // วันที่บนบิล รูปแบบ YYYY-MM-DD (ค.ศ.) ถ้าเป็น พ.ศ. ให้ลบ 543
  "amount_total": number|null,       // ยอดรวมสุทธิที่ต้องจ่าย (ตัวเลขล้วน ไม่มีคอมมา)
  "has_tax_invoice": boolean|null,   // true ถ้าเป็นใบกำกับภาษีเต็มรูป (มีคำว่า "ใบกำกับภาษี" + เลขผู้เสียภาษี)
  "vat_amount": number|null,         // ยอด VAT ที่ "พิมพ์ไว้บนบิล" (ถ้ามี ให้ใช้ค่านี้เป็นหลัก)
  "category": string|null,           // หมวดค่าใช้จ่าย (ดูกติกาด้านล่าง)
  "description": string|null         // สรุปสั้นๆ ของรายการ
}
กติกาสำคัญ:
- vendor_name: ใส่เฉพาะชื่อร้าน/ผู้ขายที่ "พิมพ์อยู่บนบิลจริง" ห้ามเดาจากโลโก้ ตราประทับ หรือบริบท ถ้าไม่ชัดเจนให้ null (เดาผิดแย่กว่าปล่อยว่าง)
- description: ถ้ามีหลายรายการ ให้สรุปรวบสั้นๆ เช่น "วัตถุดิบ 20 รายการ" หรือ "ของใช้สำนักงานหลายรายการ" ไม่ต้องลอกทุกบรรทัด
- vat_amount: ถ้าบิลมีทั้งสินค้าที่มี VAT และไม่มี VAT ให้ใช้ยอด VAT ตามที่บิลระบุเท่านั้น อย่าคำนวณ 7% จากยอดรวมทั้งหมดเอง
- หมวดค่าใช้จ่าย (category): ${categoryRule}
ถ้าอ่านค่าไหนไม่ได้ให้ใส่ null อย่าเดามั่ว ความถูกต้องสำคัญกว่าความครบ`;
}

type AnthropicUsage = { input_tokens: number; output_tokens: number };

/** Resolve the configured model (falls back to Haiku 4.5). */
export function resolvedOcrModel(): string {
  const s = getSystemSettings();
  return ocrModel(s.accounta_ocr_model ?? DEFAULT_OCR_MODEL).id;
}

export function ocrEnabled(): boolean {
  return !!getSystemSettings().accounta_ocr_enabled && !!process.env.ANTHROPIC_API_KEY;
}

/** Run OCR on a base64 image. Throws OcrError with a Thai message on any
 *  config or API problem so the route can surface it verbatim. */
export async function scanBill(args: {
  base64: string;
  mediaType: string;
  /** Active category names — when given, the model must pick one of these
   *  (or null) and the result is validated against the list. */
  categories?: string[];
}): Promise<{ result: OcrBillResult; usage: AnthropicUsage; model: string }> {
  const s = getSystemSettings();
  if (!s.accounta_ocr_enabled) {
    throw new OcrError("disabled", "ระบบ OCR ปิดอยู่ — เปิดได้ที่ตั้งค่าระบบ");
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new OcrError("no_key", "ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์");
  }
  const model = ocrModel(s.accounta_ocr_model ?? DEFAULT_OCR_MODEL).id;

  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: args.mediaType, data: args.base64 } },
            { type: "text", text: buildPrompt(args.categories) }
          ]
        }]
      })
    });
  } catch {
    throw new OcrError("network", "เชื่อมต่อบริการ OCR ไม่ได้ ลองใหม่อีกครั้ง");
  }

  if (!res.ok) {
    const status = res.status;
    let detail = "";
    try { detail = (await res.json())?.error?.message ?? ""; } catch { /* ignore */ }
    if (status === 401) throw new OcrError("bad_key", "API key ไม่ถูกต้อง");
    if (status === 429) throw new OcrError("rate_limit", "เรียกใช้ถี่เกินไป รอสักครู่แล้วลองใหม่");
    throw new OcrError("api_error", `บริการ OCR ขัดข้อง (${status})${detail ? ": " + detail : ""}`);
  }

  const json = await res.json().catch(() => null) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: AnthropicUsage;
  } | null;
  const text = json?.content?.find((c) => c.type === "text")?.text ?? "";
  const usage = json?.usage ?? { input_tokens: 0, output_tokens: 0 };

  const result = parseResult(text, args.categories);
  return { result, usage, model };
}

/** Pull the JSON object out of the model's reply (tolerant of stray text
 *  or code fences) and coerce to OcrBillResult. When `categories` is given,
 *  the parsed category is snapped to an exact (case-insensitive) member of
 *  the list, else nulled — so a hallucinated/renamed category never reaches
 *  the ledger. */
function parseResult(text: string, categories?: string[]): OcrBillResult {
  const blank: OcrBillResult = {
    vendor_name: null, tax_id: null, bill_date: null, amount_total: null,
    has_tax_invoice: null, vat_amount: null, category: null, description: null
  };
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return blank;
  let o: Record<string, unknown>;
  try { o = JSON.parse(m[0]); } catch { return blank; }

  const str = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t === "" || t.toLowerCase() === "null" ? null : t;
  };
  const num = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") { const n = Number(v.replace(/,/g, "")); return Number.isFinite(n) ? n : null; }
    return null;
  };
  const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

  // Guard the date: must look like YYYY-MM-DD with a Gregorian-ish year;
  // if the model left a B.E. year, pull it back to A.D.
  let billDate = str(o.bill_date);
  if (billDate) {
    const d = billDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!d) billDate = null;
    else {
      let y = Number(d[1]);
      if (y > 2400) y -= 543;
      billDate = `${String(y).padStart(4, "0")}-${d[2]}-${d[3]}`;
    }
  }

  // Snap category onto the allowed list (exact, case-insensitive). Anything
  // off-list → null so only real ผังหมวด values land on the bill.
  let category = str(o.category);
  if (category && categories && categories.length) {
    const hit = categories.find((c) => c.trim().toLowerCase() === category!.toLowerCase());
    category = hit ?? null;
  }

  return {
    vendor_name: str(o.vendor_name),
    tax_id: str(o.tax_id),
    bill_date: billDate,
    amount_total: num(o.amount_total),
    has_tax_invoice: bool(o.has_tax_invoice),
    vat_amount: num(o.vat_amount),
    category,
    description: str(o.description)
  };
}
