// รายงานสรุปการประชุมผู้บริหาร — PDF (owner 2026-09-02). A flowing multi-page
// report: header, วาระที่กำหนด, การเข้าร่วม + เบี้ยประชุม, สรุป AI + เช็คลิสต์ +
// ประเด็นคงค้าง, and each attendee's minutes per วาระ. Server-side via pdfkit +
// the embedded LINE Seed Sans TH font (same setup as company-overview-pdf.ts).

import PDFDocument from "pdfkit";
import path from "node:path";
import type { ExecMeetingDetail } from "./exec-meetings";

const FONT_REG = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Regular.ttf");
const FONT_BOLD = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Bold.ttf");

const TH_MONTHS = ["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
function dateLabel(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return ymd;
  return `${Number(m[3])} ${TH_MONTHS[Number(m[2])] ?? ""} ${Number(m[1]) + 543}`;
}
const money2 = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const INK = "#281a0e", BRAND = "#a06820", MUTE = "#8a7761", LINE = "#e7dcc9";

function parseJsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a as T[] : []; } catch { return []; }
}

export function generateExecMeetingPdf(d: ExecMeetingDetail): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 44 });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      doc.registerFont("th", FONT_REG);
      doc.registerFont("th-b", FONT_BOLD);

      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const W = right - left;
      const nameOf = new Map(d.invitees.map((i) => [i.user_id, `${i.title_prefix ? `${i.title_prefix} ` : ""}${i.display_name}`]));
      const hr = () => { doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.7).strokeColor(LINE).stroke(); };
      const section = (t: string) => {
        doc.moveDown(0.8);
        doc.font("th-b").fontSize(13).fillColor(BRAND).text(t, { width: W });
        doc.moveDown(0.25);
      };

      // ── Header ──
      doc.font("th-b").fontSize(20).fillColor(INK).text(d.title, { width: W });
      doc.font("th").fontSize(11).fillColor(MUTE).text(`ประชุมผู้บริหาร · วันที่ ${dateLabel(d.meeting_date)}`, { width: W });
      doc.moveDown(0.5); hr();

      // ── Agenda ──
      if (d.agenda_topics.length > 0) {
        section("วาระการประชุม");
        d.agenda_topics.forEach((t, i) =>
          doc.font("th").fontSize(11).fillColor(INK).text(`${i + 1}. ${t}`, { width: W, indent: 6 }));
      }

      // ── Attendance + fee ──
      section("การเข้าร่วมและเบี้ยประชุม");
      d.invitees.forEach((i) => {
        const status = i.ended_at ? "จบแล้ว" : i.joined_at ? "กำลังประชุม" : "ไม่เข้าร่วม";
        const mins = i.minutes != null ? `${i.minutes} นาที` : "—";
        const fee = i.fee_amount != null ? `฿${money2(i.fee_amount)}` : "—";
        doc.font("th").fontSize(10).fillColor(INK)
          .text(`• ${nameOf.get(i.user_id) ?? `#${i.user_id}`} — ${status} · ${mins} · เบี้ยประชุม ${fee}`, { width: W });
      });

      // ── AI summary + checklist + carryover ──
      if (d.ai_summary && d.ai_summary.trim()) {
        section("สรุปการประชุม (AI)");
        renderMarkdown(doc, d.ai_summary, W);
      }
      const checklist = parseJsonArray<{ item: string; owner?: string }>(d.ai_checklist);
      if (checklist.length > 0) {
        section("เช็คลิสต์ติดตามสัปดาห์หน้า");
        checklist.forEach((c) =>
          doc.font("th").fontSize(10).fillColor(INK).text(`☐ ${c.item}${c.owner ? ` — ${c.owner}` : ""}`, { width: W, indent: 6 }));
      }
      const carryover = parseJsonArray<{ item: string }>(d.ai_carryover);
      if (carryover.length > 0) {
        section("ประเด็นคงค้าง (ยกไปคุยสัปดาห์หน้า)");
        carryover.forEach((c) =>
          doc.font("th").fontSize(10).fillColor(INK).text(`• ${c.item}`, { width: W, indent: 6 }));
      }

      // ── Per-person minutes ──
      const withMinutes = d.invitees.filter((i) => i.items.length > 0);
      if (withMinutes.length > 0) {
        section("รายงานการประชุม (รายคน)");
        withMinutes.forEach((i) => {
          doc.moveDown(0.4);
          doc.font("th-b").fontSize(11).fillColor(INK).text(nameOf.get(i.user_id) ?? `#${i.user_id}`, { width: W });
          i.items.forEach((it, j) => {
            doc.font("th-b").fontSize(10).fillColor(BRAND).text(`วาระที่ ${j + 1}: ${it.topic}`, { width: W, indent: 8 });
            doc.font("th").fontSize(10).fillColor(INK)
              .text(`รายละเอียด: ${it.details || "-"}`, { width: W, indent: 14 })
              .text(`ข้อเสนอแนะ: ${it.suggestions || "-"}`, { width: W, indent: 14 })
              .text(`แผนการจัดการ: ${it.action_plan || "-"}`, { width: W, indent: 14 });
            const owners = it.owner_user_ids.map((uid) => nameOf.get(uid) ?? `#${uid}`).join(", ");
            if (owners) doc.text(`ผู้รับผิดชอบ: ${owners}`, { width: W, indent: 14 });
          });
        });
      }

      // ── Footer: AI usage ──
      if (d.ai_cost_baht != null) {
        doc.moveDown(1); hr(); doc.moveDown(0.3);
        doc.font("th").fontSize(8).fillColor(MUTE).text(
          `ใช้ AI สรุป · ${(d.ai_in_tokens ?? 0).toLocaleString("th-TH")} + ${(d.ai_out_tokens ?? 0).toLocaleString("th-TH")} tokens · ` +
          `ประมาณ ฿${money2(d.ai_cost_baht)}${d.ai_model ? ` · ${d.ai_model}` : ""}`, { width: W });
      }

      doc.end();
    } catch (e) { reject(e as Error); }
  });
}

// Light markdown for the AI summary: "###"/"##" → bold headings, "-"/"*" →
// bullets, blank line → spacing, otherwise a normal paragraph.
function renderMarkdown(doc: PDFKit.PDFDocument, md: string, W: number): void {
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) { doc.moveDown(0.3); continue; }
    const h = /^(#{2,6})\s+(.*)$/.exec(line);
    if (h) {
      doc.moveDown(0.2);
      doc.font("th-b").fontSize(11).fillColor(INK).text(h[2], { width: W });
      continue;
    }
    const b = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (b) {
      doc.font("th").fontSize(10).fillColor(INK).text(`•  ${stripInline(b[1])}`, { width: W, indent: 8 });
      continue;
    }
    doc.font("th").fontSize(10).fillColor(INK).text(stripInline(line), { width: W });
  }
}

// Drop **bold** / *italic* / `code` markers — pdfkit renders plain runs.
function stripInline(s: string): string {
  return s.replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*(.*?)\*/g, "$1").replace(/`(.*?)`/g, "$1");
}
