// ── ACCOUNTA — บทวิเคราะห์สภาพการเงิน (กูรูการเงินระดับโลก, server-only) ──
// Calls the Anthropic Messages API directly via fetch (no SDK dependency —
// keeps the 1 GB droplet lean, same convention as accounta-ocr.ts / owl-ai.ts).
// Takes a financial snapshot the route assembles from the ledger and returns a
// Thai CFO-style narrative to render below the โควตาสั่งซื้อ card. Every number
// comes from the snapshot (real DB figures) — the model is told never to invent
// numbers (owner rule: ตัวเลขจริงต้องเป๊ะ). On-demand button, admin-only at the route.
//
// Shows/works whenever the server has ANTHROPIC_API_KEY set (the same key OCR /
// น้องฮูก use) — NOT tied to the น้องฮูก on/off toggle, so the owner doesn't have
// to enable น้องฮูก just to see this button (owner 2026-07-15 "ให้ขึ้นใต้การ์ด
// โควต้าสั่งซื้อได้เลย"). No new system setting / migration.

import { logFinAnalysisUsage } from "./accounta-db";

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// Best model for the quality of analysis the owner asked for ("กูรูระดับโลก").
// One constant — easy to change if cost ever matters.
const FIN_ANALYSIS_MODEL = "claude-opus-4-8";

export class FinAnalysisError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Enabled whenever the server is configured with an Anthropic API key —
 *  independent of the น้องฮูก toggle. */
export function financialAnalysisEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

// The financial picture the route hands us — all real figures from the ledger.
export type FinancialSnapshot = {
  branchName: string;
  periodLabel: string;
  periodKind: "week" | "month" | "year";
  salesRevenue: number;
  financing: number;
  expense: number;
  net: number;
  netMarginPct: number | null;
  inputVat: number;
  outputVat: number;
  vatPayable: number;
  vatRegistered: boolean;
  forecast: number | null;
  avgPerDay: number;
  daysWithRevenue: number;
  categories: Array<{
    name: string; spent: number; pct: number | null;
    targetMin: number | null; targetMax: number | null; status: string;
  }>;
  uncategorized: number;
  outstandingTotal: number;
  topVendors: Array<{ vendor: string; amount: number }>;
  salesTarget: { hasTarget: boolean; monthlyTarget: number; monthToDateSales: number; monthPct: number };
  materialQuota: null | {
    budgetPct: number; goalPct: number | null; spentThisMonth: number;
    monthBudget: number; remainingBudget: number; salesToDate: number;
    projectedMaterial: number; cogNowPct: number | null;
    reqSalesCeil: number; reqSalesGoal: number;
  };
  payables: { whtUnpaid: number; ssoUnpaid: number; branchUnpaidTotal: number; branchUnpaidCount: number };
  cashTotal: number;
  monthlyTrend: Array<{ month: number; revenue: number; expense: number; profit: number }>;
};

const baht = (n: number) => "฿" + Math.round(n).toLocaleString("en-US");
const pct = (n: number | null) => (n == null ? "—" : n.toLocaleString("th-TH", { maximumFractionDigits: 1 }) + "%");
const STATUS_TH: Record<string, string> = {
  over: "เกินเป้า", under: "ต่ำกว่าเป้า", ok: "อยู่ในเป้า", na: "ไม่มีเป้าเทียบ"
};
const TH_MON = ["", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

const SYSTEM_PROMPT = `คุณคือ "กูรูการเงินระดับโลก" — ที่ปรึกษาการเงิน/CFO มืออาชีพระดับสากล ที่เชี่ยวชาญธุรกิจร้านอาหาร คลินิก และธุรกิจบริการขนาดเล็ก-กลางในไทยเป็นพิเศษ

หน้าที่: อ่านสรุปตัวเลขการเงินของสาขาหนึ่งในรอบเวลาที่กำหนด แล้วเขียน "บทวิเคราะห์สภาพการเงิน" ให้เจ้าของกิจการอ่านเข้าใจง่าย นำไปลงมือทำได้จริง

กติกาเหล็ก (ห้ามฝ่าฝืน):
- ตอบเป็น "ภาษาไทย" ล้วน น้ำเสียงมืออาชีพแต่เป็นกันเอง ตรงไปตรงมา
- ใช้ได้เฉพาะ "ตัวเลขที่ให้มาเท่านั้น" ห้ามแต่ง/เดา/ประมาณตัวเลขใหม่ที่ไม่มีในข้อมูล ถ้าข้อมูลไม่พอให้บอกตรงๆ ว่าข้อมูลไม่พอ
- เน้นเชิงลึกเรื่องต้นทุนวัตถุดิบ (%COG) กระแสเงินสด และหมวดที่ผิดปกติ — นี่คือหัวใจของธุรกิจแบบนี้
- อย่ายาวเกินจำเป็น เขียนกระชับ ได้ใจความ ใช้หัวข้อและ bullet (เครื่องหมาย • หรือ -) ให้อ่านง่ายแบบข้อความธรรมดา ไม่ต้องใช้ markdown ตาราง

โครงสร้างที่ต้องการ (ใช้หัวข้อประมาณนี้):
1) 🩺 สรุปสุขภาพการเงิน — ให้ "คะแนน" (เช่น 7/10) + สรุป 2-3 ประโยค
2) ✅ จุดแข็ง
3) ⚠️ สัญญาณเตือน/ความเสี่ยง
4) 📊 วิเคราะห์ต้นทุน %COG และหมวดค่าใช้จ่ายที่เกิน/ต่ำกว่าเป้า
5) 💵 กระแสเงินสด / ลูกหนี้ / เจ้าหนี้ / ภาษี
6) 🎯 คำแนะนำลงมือทำ 3-5 ข้อ (เจาะจง ทำได้ทันที มีตัวเลขอ้างอิง)`;

function buildUserContent(s: FinancialSnapshot): string {
  const lines: string[] = [];
  lines.push(`สาขา: ${s.branchName}`);
  lines.push(`รอบเวลา: ${s.periodLabel} (${s.periodKind === "month" ? "รายเดือน" : s.periodKind === "week" ? "รายสัปดาห์" : "รายปี"})`);
  lines.push("");
  lines.push("── รายรับ-รายจ่าย ──");
  lines.push(`ยอดขาย: ${baht(s.salesRevenue)}`);
  if (s.financing > 0) lines.push(`เงินกู้/รายรับอื่น (ไม่นับเป็นยอดขาย): ${baht(s.financing)}`);
  lines.push(`ค่าใช้จ่ายรวม: ${baht(s.expense)}`);
  lines.push(`กำไรสุทธิ (ยอดขาย − ค่าใช้จ่าย): ${baht(s.net)}${s.netMarginPct != null ? ` · อัตรากำไรสุทธิ ${pct(s.netMarginPct)}` : ""}`);
  if (s.daysWithRevenue > 0) lines.push(`วันที่มีรายรับ: ${s.daysWithRevenue} วัน · เฉลี่ย/วัน ${baht(s.avgPerDay)}`);
  if (s.forecast != null) lines.push(`คาดการณ์ยอดขายทั้งเดือน (run-rate): ${baht(s.forecast)}`);
  lines.push("");
  if (s.salesTarget.hasTarget) {
    lines.push("── เป้ายอดขายเดือนนี้ ──");
    lines.push(`เป้าทั้งเดือน: ${baht(s.salesTarget.monthlyTarget)} · ทำได้แล้ว ${baht(s.salesTarget.monthToDateSales)} (${pct(s.salesTarget.monthPct)} ของเป้า)`);
    lines.push("");
  }
  if (s.materialQuota) {
    const q = s.materialQuota;
    lines.push("── ต้นทุนวัตถุดิบ / โควตาสั่งซื้อ (COG) ──");
    lines.push(`เพดาน %COG: ${q.budgetPct}%${q.goalPct != null ? ` · เป้าที่อยากได้ ${q.goalPct}%` : ""}`);
    lines.push(`%COG ปัจจุบัน (ต้นทุนวัตถุดิบสะสม ÷ ยอดขายสะสม): ${pct(q.cogNowPct)}`);
    lines.push(`ต้นทุนวัตถุดิบเดือนนี้ (ใช้ไปแล้ว): ${baht(q.spentThisMonth)} จากงบ ${baht(q.monthBudget)} · เหลือ ${baht(q.remainingBudget)}`);
    lines.push(`คาดการณ์ต้นทุนวัตถุดิบทั้งเดือน (run-rate): ${baht(q.projectedMaterial)}`);
    lines.push(`ต้องขาย/วันจากนี้เพื่อคุม COG ให้ไม่เกินเพดาน: ${baht(q.reqSalesCeil)}${q.goalPct != null ? ` (เพื่อถึงเป้า ${q.goalPct}%: ${baht(q.reqSalesGoal)})` : ""}`);
    lines.push("");
  }
  lines.push("── ค่าใช้จ่ายแยกตามหมวด (เทียบเป้า %ของยอดขาย) ──");
  if (s.categories.length === 0) {
    lines.push("(ไม่มีค่าใช้จ่ายในรอบนี้)");
  } else {
    for (const c of s.categories) {
      const target = c.targetMin != null || c.targetMax != null
        ? ` · เป้า ${c.targetMin ?? 0}%–${c.targetMax ?? "∞"}% [${STATUS_TH[c.status] ?? c.status}]`
        : "";
      lines.push(`• ${c.name}: ${baht(c.spent)} (${pct(c.pct)} ของยอดขาย)${target}`);
    }
  }
  if (s.uncategorized > 0) lines.push(`• ยังไม่จัดหมวด: ${baht(s.uncategorized)}`);
  lines.push("");
  if (s.topVendors.length > 0) {
    lines.push("── ผู้จำหน่ายที่จ่ายมากสุด ──");
    for (const v of s.topVendors) lines.push(`• ${v.vendor}: ${baht(v.amount)}`);
    lines.push("");
  }
  lines.push("── กระแสเงินสด / ลูกหนี้ / เจ้าหนี้ / ภาษี ──");
  lines.push(`เงินสด+ธนาคารคงเหลือรวม: ${baht(s.cashTotal)}`);
  lines.push(`ลูกหนี้ค้างรับ (AR): ${baht(s.outstandingTotal)}`);
  lines.push(`บิลค้างจ่ายในสาขา: ${baht(s.payables.branchUnpaidTotal)} (${s.payables.branchUnpaidCount} รายการ)`);
  lines.push(`ภาษีหัก ณ ที่จ่ายค้างนำส่ง: ${baht(s.payables.whtUnpaid)} · ประกันสังคมค้างนำส่ง: ${baht(s.payables.ssoUnpaid)}`);
  if (s.vatRegistered) {
    lines.push(`ภาษีซื้อ: ${baht(s.inputVat)} · ภาษีขาย: ${baht(s.outputVat)} · ภพ.30 ที่ต้องชำระ: ${baht(s.vatPayable)}`);
  } else {
    lines.push("ยังไม่จด VAT");
  }
  lines.push("");
  if (s.monthlyTrend.some((m) => m.revenue > 0 || m.expense > 0)) {
    lines.push("── แนวโน้ม 12 เดือน (รายรับ / รายจ่าย / กำไร) ──");
    for (const m of s.monthlyTrend) {
      if (m.revenue === 0 && m.expense === 0) continue;
      lines.push(`${TH_MON[m.month] ?? m.month}: รับ ${baht(m.revenue)} · จ่าย ${baht(m.expense)} · กำไร ${baht(m.profit)}`);
    }
  }
  return lines.join("\n");
}

/** Call Claude with the assembled snapshot and STREAM the answer back as a
 *  ReadableStream of UTF-8 text (only `text_delta` content is forwarded).
 *
 *  Streaming is required, not a nicety: prod Nginx has `proxy_read_timeout 60s`
 *  and serves the maintenance page on 504. A non-streaming Opus call on the 1 GB
 *  droplet sends nothing until the whole answer is ready and blows past 60s;
 *  streaming keeps bytes flowing so each delta resets the read timer
 *  (Nginx already runs `proxy_buffering off`).
 *
 *  Any config/API problem is thrown as FinAnalysisError BEFORE the stream starts
 *  so the route can return a JSON error instead of an empty stream. */
export async function streamFinancialAnalysis(
  snapshot: FinancialSnapshot,
  userId: number,
  branchId: number
): Promise<ReadableStream<Uint8Array>> {
  if (!financialAnalysisEnabled()) {
    throw new FinAnalysisError("disabled", "ฟีเจอร์ผู้ช่วย AI ปิดอยู่ — เปิดได้ที่ตั้งค่าระบบ");
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new FinAnalysisError("no_key", "ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์");
  }

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
        model: FIN_ANALYSIS_MODEL,
        max_tokens: 8000,
        // No extended thinking on purpose: a thinking phase emits no *visible*
        // text, so with our text-only re-stream nothing would reach Nginx during
        // it — and a >60s think would still trip proxy_read_timeout. Plain output
        // starts within a few seconds so bytes flow continuously and reset the
        // read timer. Opus 4.8 without thinking is still strong for this task.
        stream: true,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserContent(snapshot) }]
      })
    });
  } catch {
    throw new FinAnalysisError("network", "เชื่อมต่อบริการ AI ไม่ได้ ลองใหม่อีกครั้ง");
  }

  if (!res.ok || !res.body) {
    const status = res.status;
    let detail = "";
    try { detail = (await res.json())?.error?.message ?? ""; } catch { /* ignore */ }
    if (status === 401) throw new FinAnalysisError("bad_key", "API key ไม่ถูกต้อง");
    if (status === 429) throw new FinAnalysisError("rate_limit", "เรียกใช้ถี่เกินไป รอสักครู่แล้วลองใหม่");
    throw new FinAnalysisError("api_error", `บริการ AI ขัดข้อง (${status})${detail ? ": " + detail : ""}`);
  }

  // Re-stream: parse Anthropic SSE and emit only text_delta text. The upstream
  // body arrives as `event:`/`data: {json}` line pairs; a `data:` line can be
  // split across chunks, so we buffer the trailing partial line.
  const upstream = res.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  // Token usage arrives in message_start (input) + message_delta (cumulative
  // output); log it once when the stream ends so the AI spend counter includes
  // this call. A DB error here must never break the user-facing stream.
  let inputTokens = 0;
  let outputTokens = 0;
  let logged = false;
  const flushUsage = () => {
    if (logged) return;
    logged = true;
    try {
      logFinAnalysisUsage({ model: FIN_ANALYSIS_MODEL, inputTokens, outputTokens, branchId, userId });
    } catch { /* never break the stream over a usage-log write */ }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await upstream.read();
        if (done) {
          flushUsage();
          controller.close();
          return;
        }
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? ""; // keep the last, possibly-incomplete line
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let evt: {
            type?: string;
            delta?: { type?: string; text?: string };
            message?: { usage?: { input_tokens?: number; output_tokens?: number } };
            usage?: { output_tokens?: number };
          };
          try { evt = JSON.parse(payload); } catch { continue; }
          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
            controller.enqueue(encoder.encode(evt.delta.text));
          } else if (evt.type === "message_start") {
            inputTokens = evt.message?.usage?.input_tokens ?? inputTokens;
            outputTokens = evt.message?.usage?.output_tokens ?? outputTokens;
          } else if (evt.type === "message_delta" && typeof evt.usage?.output_tokens === "number") {
            outputTokens = evt.usage.output_tokens; // cumulative — keep latest
          }
        }
      } catch {
        // Upstream hiccup mid-stream — bill what we saw, then end gracefully.
        flushUsage();
        controller.close();
      }
    },
    cancel() {
      flushUsage();
      upstream.cancel().catch(() => { /* ignore */ });
    }
  });
}
