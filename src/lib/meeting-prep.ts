// เตรียมประชุมประจำสัปดาห์ — AI สรุปรายงานผู้จัดการ (server-only, owner 2026-08-04).
//
// รวมรายงานผู้จัดการทั้งสัปดาห์ (ปิดกะ + สถานการณ์ + เรื่องเสนอเข้าประชุม) ส่งให้
// Claude ช่วยจัดเป็น "วาระประชุม" ที่อ่านง่าย — เก็บผลไว้ใน meeting_prep_summaries
// เพื่อเปิดอ่านวันพุธ. เรียก Anthropic Messages API ตรงผ่าน fetch แบบ non-streaming
// (เอาต์พุตสั้นพอ อยู่ในลิมิต Nginx 60s) — แนวเดียวกับ financial-analysis.ts.
// on-demand (ปุ่มกด), admin-only ที่ route. ใช้ ANTHROPIC_API_KEY ตัวเดียวกับ AI อื่น.
import type Database from "better-sqlite3";
import { logFinAnalysisUsage } from "./accounta-db";
import { listManagerReports, type ManagerReportRow } from "./manager-reports";
import { nameWithPrefix } from "./name";

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// Sonnet — สมดุล + เร็วพอสำหรับ non-streaming ใต้ลิมิต Nginx 60s (สรุปไม่ยาว).
const PREP_MODEL = "claude-sonnet-4-6";

export class MeetingPrepError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function meetingPrepEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/** เรียก Claude แบบ non-streaming — คืนข้อความเต็ม + token usage. ใช้ร่วมกับเฟส C
 *  (สร้างเช็กลิสต์). โยน MeetingPrepError เป็นภาษาไทยเมื่อ config/API ผิดพลาด. */
export async function callClaude(opts: {
  system: string; user: string; model?: string; maxTokens?: number;
}): Promise<{ text: string; model: string; inputTokens: number; outputTokens: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new MeetingPrepError("no_key", "ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์");
  const model = opts.model ?? PREP_MODEL;

  // ตัดที่ 55s — ต่ำกว่า Nginx proxy_read_timeout 60s เพื่อให้ตอบ error สะอาดแทนที่
  // จะค้างจน 504 (การเรียกแบบ non-streaming ไม่มี byte ไหลระหว่างรอ).
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 55_000);
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
        max_tokens: opts.maxTokens ?? 2000,
        system: opts.system,
        messages: [{ role: "user", content: opts.user }]
      }),
      signal: ac.signal
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new MeetingPrepError("timeout", "AI ใช้เวลานานเกินไป ลองใหม่ หรือลดช่วงวันที่ลง");
    }
    throw new MeetingPrepError("network", "เชื่อมต่อบริการ AI ไม่ได้ ลองใหม่อีกครั้ง");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const status = res.status;
    let detail = "";
    try { detail = (await res.json())?.error?.message ?? ""; } catch { /* ignore */ }
    if (status === 401) throw new MeetingPrepError("bad_key", "API key ไม่ถูกต้อง");
    if (status === 429) throw new MeetingPrepError("rate_limit", "เรียกใช้ถี่เกินไป รอสักครู่แล้วลองใหม่");
    throw new MeetingPrepError("api_error", `บริการ AI ขัดข้อง (${status})${detail ? ": " + detail : ""}`);
  }

  const data = await res.json().catch(() => null) as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  } | null;
  const text = (data?.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text).join("").trim();
  if (!text) throw new MeetingPrepError("empty", "AI ไม่ได้ส่งผลลัพธ์กลับมา ลองใหม่อีกครั้ง");
  return {
    text, model,
    inputTokens: data?.usage?.input_tokens ?? 0,
    outputTokens: data?.usage?.output_tokens ?? 0
  };
}

const SYSTEM_PROMPT = `คุณคือผู้ช่วยเตรียมการประชุมประจำสัปดาห์ของธุรกิจร้านอาหาร/คลินิกในไทย

หน้าที่: อ่าน "รายงานประจำวันจากผู้จัดการสาขา" ตลอดสัปดาห์ (รายงานปิดกะ/ยอดขาย, สถานการณ์-ปัญหาประจำวัน, และเรื่องที่ผู้จัดการอยากยกเข้าประชุม) แล้วเรียบเรียงเป็น "วาระการประชุม" ที่กระชับ อ่านง่าย ให้เจ้าของ/หัวหน้าใช้ประชุมได้ทันที

กติกา:
- ตอบเป็น "ภาษาไทย" ล้วน น้ำเสียงมืออาชีพแต่กระชับ ตรงประเด็น
- อ้างอิงเฉพาะสิ่งที่มีในรายงานเท่านั้น ห้ามแต่งตัวเลข/เหตุการณ์ที่ไม่มี ถ้าข้อมูลบางส่วนไม่ชัดให้ระบุว่า "ต้องสอบถามเพิ่ม"
- จัดกลุ่มเรื่องที่เกี่ยวข้องเข้าด้วยกัน (เช่น เรื่องคน, สต๊อก/อุปกรณ์, ยอดขาย, ลูกค้า) — อย่าลอกทีละวัน
- เน้นเรื่องที่ "เกิดซ้ำหลายวัน" หรือ "ผู้จัดการขอให้ยกเข้าประชุม" เป็นพิเศษ
- ใช้ข้อความธรรมดา + bullet (• หรือ -) ไม่ต้องใช้ตาราง markdown

โครงสร้างที่ต้องการ:
1) สรุปภาพรวมสัปดาห์ (2-3 ประโยค)
2) เรื่องเด่น/ต้องตัดสินใจในที่ประชุม (จัดเป็นหัวข้อ พร้อมบริบทสั้นๆ ว่าเกิดวันไหน/กี่ครั้ง)
3) ปัญหา/ความเสี่ยงที่ต้องติดตาม
4) เรื่องที่ผู้จัดการเสนอ (สรุปรวม)
5) ข้อเสนอวาระประชุม (bullet สั้นๆ พร้อมประชุม)`;

function buildReportsContent(reports: ManagerReportRow[], branchName: string, from: string, to: string): string {
  const lines: string[] = [];
  lines.push(`สาขา: ${branchName}`);
  lines.push(`ช่วงรายงาน: ${from} ถึง ${to} (จำนวน ${reports.length} รายงาน)`);
  lines.push("");
  // เรียงเก่า→ใหม่ ให้ AI เห็นลำดับเวลา
  const ordered = [...reports].sort((a, b) =>
    a.report_date < b.report_date ? -1 : a.report_date > b.report_date ? 1 : a.id - b.id);
  for (const r of ordered) {
    const who = nameWithPrefix(r.author_prefix, r.author_name ?? "") || "ผู้จัดการ";
    const scope = r.branch_name ?? "ระดับบริษัท";
    lines.push(`── ${r.report_date} · ${who} · ${scope} ──`);
    if (r.shift_summary) lines.push(`[ปิดกะ/ยอดขาย] ${r.shift_summary}`);
    if (r.situation) lines.push(`[สถานการณ์/ปัญหา] ${r.situation}`);
    if (r.meeting_topics) lines.push(`[ขอเข้าประชุม] ${r.meeting_topics}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** รวมรายงานช่วง [from,to] ของสาขา (รวมระดับบริษัท) → ให้ AI สรุป → บันทึกผลลง
 *  meeting_prep_summaries + log ค่าใช้จ่าย. คืนแถวสรุปที่บันทึก. โยน no_reports
 *  ถ้าไม่มีรายงานในช่วงนั้น. */
export async function summarizeWeeklyReports(db: Database.Database, opts: {
  branchId: number | null; branchName: string; from: string; to: string; userId: number;
}): Promise<{ id: number; summary: string; reportCount: number; model: string }> {
  const reports = listManagerReports(db, { branchId: opts.branchId, from: opts.from, to: opts.to });
  if (!reports.length) {
    throw new MeetingPrepError("no_reports", "ยังไม่มีรายงานผู้จัดการในช่วงนี้ — ให้ผู้จัดการส่งรายงานก่อน");
  }

  const out = await callClaude({
    system: SYSTEM_PROMPT,
    user: buildReportsContent(reports, opts.branchName, opts.from, opts.to),
    model: PREP_MODEL,
    maxTokens: 2500
  });

  const res = db.prepare(`
    INSERT INTO meeting_prep_summaries
      (branch_id, period_from, period_to, summary, report_count, model, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(opts.branchId, opts.from, opts.to, out.text, reports.length, out.model, opts.userId);

  try {
    logFinAnalysisUsage({
      model: out.model, inputTokens: out.inputTokens, outputTokens: out.outputTokens,
      branchId: opts.branchId, userId: opts.userId
    });
  } catch { /* never fail the summary over a usage-log write */ }

  return { id: Number(res.lastInsertRowid), summary: out.text, reportCount: reports.length, model: out.model };
}

const CHECKLIST_SYSTEM = `คุณคือผู้ช่วยแปลง "สรุป/มติการประชุม" เป็นรายการงานที่ต้องทำต่อ (action items)

หน้าที่: อ่านสรุปการประชุม แล้วดึงเฉพาะ "สิ่งที่ต้องลงมือทำต่อ" ออกมาเป็นข้อๆ

กติกา:
- ตอบเป็นภาษาไทย
- แต่ละงานสั้น กระชับ เป็นประโยคสั่งการที่ทำได้จริง เริ่มด้วยคำกริยา (เช่น "สั่งซื้อ…", "นัดช่างซ่อม…", "จัดตารางเวร…")
- เอาเฉพาะสิ่งที่ต้อง "ทำ" — ข้ามข้อมูลทั่วไป/บริบทที่ไม่ใช่งาน
- ตอบเป็น "รายการเท่านั้น" หนึ่งงานต่อหนึ่งบรรทัด ห้ามใส่เลขลำดับ เครื่องหมาย bullet หัวข้อ หรือคำอธิบายเพิ่มเติม
- ถ้าไม่มีงานที่ต้องทำชัดเจน ให้ตอบบรรทัดเดียวว่า: (ไม่มี)`;

/** ให้ AI เสนอ action item จากสรุป/มติการประชุม — คืนเฉพาะข้อความงาน (ยังไม่บันทึก
 *  ให้ผู้ใช้ตรวจ/เลือกก่อน). log ค่าใช้จ่ายทันที. */
export async function suggestActionItems(
  summary: string, userId: number, branchId: number | null
): Promise<{ items: string[]; model: string }> {
  const text = summary.trim();
  if (!text) throw new MeetingPrepError("empty_summary", "การประชุมนี้ยังไม่มีสรุป/มติ — กรอกสรุปก่อนให้ AI สร้างเช็กลิสต์");

  const out = await callClaude({
    system: CHECKLIST_SYSTEM,
    user: `สรุป/มติการประชุม:\n\n${text}`,
    maxTokens: 1200
  });
  const items = out.text.split("\n")
    // ตัดเฉพาะ bullet (- • *) หรือเลขลำดับรูปแบบ "1." / "12)" ที่ตามด้วยช่องว่าง —
    // ไม่ตัดเลขที่เป็นเนื้อหาจริง เช่น "24 ชม." (ไม่มีจุด/วงเล็บตามหลัง)
    .map((s) => s.replace(/^\s*(?:[-•*]\s*|\d{1,2}[.)]\s+)/, "").trim())
    .filter((s) => s && s !== "(ไม่มี)")
    .slice(0, 30);

  try {
    logFinAnalysisUsage({
      model: out.model, inputTokens: out.inputTokens, outputTokens: out.outputTokens, branchId, userId
    });
  } catch { /* never fail over a usage-log write */ }

  return { items, model: out.model };
}

export type PrepSummaryRow = {
  id: number;
  branch_id: number | null;
  period_from: string;
  period_to: string;
  summary: string;
  report_count: number;
  model: string | null;
  created_by: number | null;
  created_at: string;
};

/** สรุปล่าสุดของสาขา (รวมระดับบริษัท) — ใช้แสดงบนหน้าเตรียมประชุม. */
export function getLatestPrepSummary(db: Database.Database, branchId: number | null): PrepSummaryRow | undefined {
  const where = branchId != null ? "WHERE branch_id = ? OR branch_id IS NULL" : "";
  const params = branchId != null ? [branchId] : [];
  return db.prepare(
    `SELECT * FROM meeting_prep_summaries ${where} ORDER BY created_at DESC, id DESC LIMIT 1`
  ).get(...params) as PrepSummaryRow | undefined;
}
