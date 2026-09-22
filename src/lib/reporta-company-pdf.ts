// ANALYTICA · ภาพรวมบริษัท (รวมทุกสาขา) — PDF report (owner 2026-09-25). A one-
// page A4 mirror of the company overview page: sales KPI cards with the MoM
// change, monthly + annual target progress bars, and a per-branch table.
// Server-side via pdfkit + the embedded LINE Seed Sans TH font (same setup as
// company-overview-pdf.ts).

import PDFDocument from "pdfkit";
import path from "node:path";
import type { CompanyOverview } from "./salesa-analytics";

const FONT_REG = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Regular.ttf");
const FONT_BOLD = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Bold.ttf");

const money = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const intTh = (n: number) => n.toLocaleString("th-TH");
function momLabel(pct: number | null): string {
  if (pct == null) return "—";
  return `${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(0)}%`;
}

const INK = "#281a0e", BRAND = "#a06820", MUTE = "#8a7761";
const GREEN = "#2e7d32", AMBER = "#b8860b", RED = "#c0392b", CARD = "#faf6ef", LINE = "#e7dcc9", TRACK = "#f0e7d6";

// null MoM (no comparable prior-month window) is neutral, not green.
const momColor = (pct: number | null): string => (pct == null ? MUTE : pct >= 0 ? GREEN : RED);

export type ReportaCompanyPdfMeta = { companyName: string; monthLabel: string };

export function generateReportaCompanyPdf(ov: CompanyOverview, meta: ReportaCompanyPdfMeta): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 40 });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      doc.registerFont("th", FONT_REG);
      doc.registerFont("th-b", FONT_BOLD);

      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const W = right - left;
      const t = ov.total;

      // ── Header band ──
      doc.rect(0, 0, doc.page.width, 92).fill(INK);
      doc.font("th-b").fontSize(22).fillColor("#ffffff").text(meta.companyName, left, 22, { width: W });
      doc.font("th").fontSize(12).fillColor("#d9c4a6")
        .text(`ภาพรวมบริษัท · รวมทุกสาขา · ${meta.monthLabel}`, left, 54, { width: W });
      doc.font("th").fontSize(8).fillColor("#b79a72")
        .text(`ยอดขายวันที่ 1–${ov.throughDay} · เทียบช่วงเวลาเดียวกันของเดือนก่อน · ใช้ติดตามภายใน`, left, 72, { width: W });

      // ── KPI cards ──
      let y = 112;
      const gap = 12, cardW = (W - gap * 2) / 3, cardH = 84;
      const kpis = [
        { label: `ยอดขายรวม (วันที่ 1–${ov.throughDay})`, value: `฿${money(t.mtdNett)}`, sub: `เทียบเดือนก่อน ${momLabel(t.momPct)}`, subColor: momColor(t.momPct), color: BRAND },
        { label: "จำนวนบิลรวม", value: intTh(t.bills), sub: ov.isCurrentMonth && t.todayNett != null ? `วันนี้ ฿${money(t.todayNett)}` : "ทั้งบริษัท", subColor: MUTE, color: "#9a6a3a" },
        { label: "ลูกค้ารวม", value: intTh(t.pax), sub: `${ov.branchCount} สาขา`, subColor: MUTE, color: GREEN }
      ];
      kpis.forEach((k, i) => {
        const x = left + i * (cardW + gap);
        doc.roundedRect(x, y, cardW, cardH, 10).fill(CARD);
        doc.roundedRect(x, y, cardW, cardH, 10).lineWidth(0.8).stroke(LINE);
        doc.rect(x, y + 10, 4, cardH - 20).fill(k.color);
        doc.font("th").fontSize(9).fillColor(MUTE).text(k.label, x + 16, y + 12, { width: cardW - 24 });
        doc.font("th-b").fontSize(19).fillColor(INK).text(k.value, x + 16, y + 32, { width: cardW - 24 });
        doc.font("th").fontSize(9).fillColor(k.subColor).text(k.sub, x + 16, y + 60, { width: cardW - 24 });
      });
      y += cardH + 20;

      // ── Progress bar helper ──
      const progressBar = (label: string, right2: string, pct: number, note: string, noteColor: string) => {
        doc.font("th").fontSize(10).fillColor(MUTE).text(label, left, y, { width: W - 90 });
        doc.font("th-b").fontSize(11).fillColor(pct >= 100 ? GREEN : INK).text(right2, left, y, { width: W, align: "right" });
        y += 18;
        const barH = 12;
        doc.roundedRect(left, y, W, barH, 4).fill(TRACK);
        const w = Math.max(2, Math.min(1, pct / 100) * W);
        doc.roundedRect(left, y, w, barH, 4).fill(pct >= 100 ? GREEN : "#5bb98b");
        y += barH + 6;
        doc.font("th").fontSize(9).fillColor(noteColor).text(note, left, y, { width: W });
        y += 20;
      };

      // ── Monthly target ──
      if (ov.target) {
        progressBar(
          `เป้ารายเดือนรวม (${ov.targetedBranchCount} สาขาที่ตั้งเป้า) · ฿${money(ov.target.target)}`,
          `${ov.target.pctOfTarget.toFixed(0)}% ของเป้า`,
          ov.target.pctOfTarget,
          `คาดสิ้นเดือน ฿${money(ov.target.projectedNett)} (${ov.target.projectedPct.toFixed(0)}% ของเป้า) · ${ov.target.onTrack ? "มีแนวโน้มถึงเป้า" : "ต่ำกว่าเป้า ต้องเร่ง"}`,
          ov.target.onTrack ? GREEN : AMBER
        );
      }
      // ── Annual target ──
      if (ov.annual) {
        progressBar(
          `เป้าทั้งปี ${ov.annual.year + 543} รวมบริษัท · ฿${money(ov.annual.annualTarget)}`,
          `${ov.annual.pctOfTarget.toFixed(0)}% ของเป้า`,
          ov.annual.pctOfTarget,
          `YTD ฿${money(ov.annual.ytdNett)} · คาดสิ้นปี ฿${money(ov.annual.projectedNett)} (${ov.annual.projectedPct.toFixed(0)}% ของเป้า)`,
          ov.annual.onTrack ? GREEN : AMBER
        );
      }

      // ── Per-branch table ──
      y += 4;
      doc.font("th-b").fontSize(13).fillColor(INK).text(`เทียบรายสาขา (วันที่ 1–${ov.throughDay})`, left, y);
      y += 22;
      // Columns: สาขา | ยอดขาย | เทียบ | เป้าเดือน | ทำได้ | บิล
      const cols = [
        { x: left, w: 150, align: "left" as const },
        { x: left + 150, w: 95, align: "right" as const },
        { x: left + 245, w: 55, align: "right" as const },
        { x: left + 300, w: 95, align: "right" as const },
        { x: left + 395, w: 55, align: "right" as const },
        { x: left + 450, w: W - 450, align: "right" as const }
      ];
      const heads = ["สาขา", "ยอดขาย", "เทียบ", "เป้าเดือน", "ทำได้", "บิล"];
      doc.font("th-b").fontSize(9).fillColor(MUTE);
      heads.forEach((h, i) => doc.text(h, cols[i].x, y, { width: cols[i].w, align: cols[i].align }));
      y += 15;
      doc.moveTo(left, y).lineTo(right, y).lineWidth(0.8).stroke(LINE);
      y += 6;

      const sorted = [...ov.branches].sort((a, b) => b.mtdNett - a.mtdNett);
      for (const b of sorted) {
        // Start a new page before a row would run into the footer (many branches).
        if (y > doc.page.height - 90) { doc.addPage(); y = 50; }
        doc.font("th-b").fontSize(10).fillColor(INK).text(b.branchName, cols[0].x, y, { width: cols[0].w, ellipsis: true });
        doc.font("th").fontSize(10).fillColor(INK).text(`฿${money(b.mtdNett)}`, cols[1].x, y, { width: cols[1].w, align: "right" });
        doc.font("th").fontSize(9).fillColor(momColor(b.momPct)).text(momLabel(b.momPct), cols[2].x, y, { width: cols[2].w, align: "right" });
        doc.font("th").fontSize(9).fillColor(MUTE).text(b.monthTarget != null ? `฿${money(b.monthTarget)}` : "—", cols[3].x, y, { width: cols[3].w, align: "right" });
        doc.font("th").fontSize(9).fillColor(MUTE).text(b.pctOfTarget != null ? `${b.pctOfTarget.toFixed(0)}%` : "—", cols[4].x, y, { width: cols[4].w, align: "right" });
        doc.font("th").fontSize(9).fillColor(MUTE).text(intTh(b.bills), cols[5].x, y, { width: cols[5].w, align: "right" });
        y += 20;
      }
      // Total row
      if (y > doc.page.height - 90) { doc.addPage(); y = 50; }
      doc.moveTo(left, y).lineTo(right, y).lineWidth(1).stroke(INK);
      y += 6;
      doc.font("th-b").fontSize(10).fillColor(INK).text("รวมบริษัท", cols[0].x, y, { width: cols[0].w });
      doc.font("th-b").fontSize(10).fillColor(INK).text(`฿${money(t.mtdNett)}`, cols[1].x, y, { width: cols[1].w, align: "right" });
      doc.font("th-b").fontSize(9).fillColor(momColor(t.momPct)).text(momLabel(t.momPct), cols[2].x, y, { width: cols[2].w, align: "right" });
      doc.font("th-b").fontSize(9).fillColor(MUTE).text(ov.target ? `฿${money(ov.target.target)}` : "—", cols[3].x, y, { width: cols[3].w, align: "right" });
      doc.font("th-b").fontSize(9).fillColor(MUTE).text(ov.target ? `${ov.target.pctOfTarget.toFixed(0)}%` : "—", cols[4].x, y, { width: cols[4].w, align: "right" });
      doc.font("th-b").fontSize(9).fillColor(MUTE).text(intTh(t.bills), cols[5].x, y, { width: cols[5].w, align: "right" });

      doc.font("th").fontSize(8).fillColor(MUTE)
        .text(`ออกรายงานเมื่อ ${new Date().toLocaleString("th-TH")} · IKIGAI OS · ANALYTICA`, left, doc.page.height - 40, { width: W, align: "center" });

      doc.end();
    } catch (e) { reject(e); }
  });
}
