// ภาพรวมบริษัท — PDF infographic for C-level (owner 2026-09-02). A one-page A4
// summary of the company's month: sales / expense / net KPI cards with the
// month-over-month change, a per-branch comparison with sales bars, and a
// tax / payables / year-to-date footer. Server-side via pdfkit + the embedded
// LINE Seed Sans TH font (same setup as revshare-statement-pdf.ts).

import PDFDocument from "pdfkit";
import path from "node:path";
import type { CompanyOverviewMonth } from "./accounta-db";

const FONT_REG = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Regular.ttf");
const FONT_BOLD = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Bold.ttf");

const TH_MONTHS = ["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${TH_MONTHS[m] ?? ""} ${y + 543}`;
}
const money = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const money2 = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function pct(cur: number, prev: number): string {
  if (!prev) return "—";
  const d = ((cur - prev) / Math.abs(prev)) * 100;
  return `${d >= 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(0)}%`;
}

const INK = "#281a0e", BRAND = "#a06820", MUTE = "#8a7761";
const GREEN = "#2e7d32", RED = "#c0392b", CARD = "#faf6ef", LINE = "#e7dcc9";

export function generateCompanyOverviewPdf(ov: CompanyOverviewMonth): Promise<Buffer> {
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

      // ── Header band ──
      doc.rect(0, 0, doc.page.width, 92).fill(INK);
      doc.font("th-b").fontSize(22).fillColor("#ffffff").text(ov.companyName, left, 24, { width: W });
      doc.font("th").fontSize(12).fillColor("#d9c4a6")
        .text(`ภาพรวมบริษัท · ${monthLabel(ov.month)}`, left, 56, { width: W });
      doc.font("th").fontSize(8).fillColor("#b79a72")
        .text("ตัวเลขรวมทุกสาขา · ใช้ติดตามภายใน ไม่ใช่เอกสารยื่นภาษี", left, 74, { width: W });

      // ── KPI cards ──
      let y = 112;
      const gap = 12, cardW = (W - gap * 2) / 3, cardH = 92;
      const kpis = [
        { label: "ยอดขายรวม", value: ov.totals.sales, delta: pct(ov.totals.sales, ov.prev.sales), color: BRAND, good: ov.totals.sales >= ov.prev.sales },
        { label: "รายจ่ายรวม", value: ov.totals.expense, delta: pct(ov.totals.expense, ov.prev.expense), color: "#9a6a3a", good: ov.totals.expense <= ov.prev.expense },
        { label: "กำไรสุทธิ (ก่อนภาษี)", value: ov.totals.net, delta: pct(ov.totals.net, ov.prev.net), color: ov.totals.net >= 0 ? GREEN : RED, good: ov.totals.net >= ov.prev.net }
      ];
      kpis.forEach((k, i) => {
        const x = left + i * (cardW + gap);
        doc.roundedRect(x, y, cardW, cardH, 10).fill(CARD);
        doc.roundedRect(x, y, cardW, cardH, 10).lineWidth(0.8).stroke(LINE);
        doc.rect(x, y + 10, 4, cardH - 20).fill(k.color);
        doc.font("th").fontSize(10).fillColor(MUTE).text(k.label, x + 16, y + 14, { width: cardW - 24 });
        doc.font("th-b").fontSize(20).fillColor(k.value >= 0 ? INK : RED)
          .text(money(k.value), x + 16, y + 34, { width: cardW - 24 });
        doc.font("th").fontSize(9).fillColor(k.good ? GREEN : RED)
          .text(`${k.delta} เทียบเดือนก่อน`, x + 16, y + 66, { width: cardW - 24 });
      });

      // ── Per-branch comparison (sales bars) ──
      y += cardH + 26;
      doc.font("th-b").fontSize(13).fillColor(INK).text("เทียบรายสาขา", left, y);
      y += 24;
      const maxSales = Math.max(1, ...ov.branches.map((b) => b.sales));
      const barX = left + 150, barW = W - 150 - 150;
      const sorted = [...ov.branches].sort((a, b) => b.sales - a.sales);
      for (const b of sorted) {
        const share = ov.totals.sales > 0 ? (b.sales / ov.totals.sales) * 100 : 0;
        doc.font("th-b").fontSize(10).fillColor(INK).text(b.name, left, y + 3, { width: 146, ellipsis: true });
        doc.roundedRect(barX, y, barW, 16, 3).fill("#f0e7d6");
        const w = Math.max(2, (b.sales / maxSales) * barW);
        doc.roundedRect(barX, y, w, 16, 3).fill(BRAND);
        doc.font("th").fontSize(9).fillColor(b.net >= 0 ? GREEN : RED)
          .text(`${money(b.sales)}  ·  กำไร ${money(b.net)}`, barX + barW + 8, y + 3, { width: 142, align: "left" });
        doc.font("th").fontSize(8).fillColor("#ffffff").text(`${share.toFixed(0)}%`, barX + 6, y + 4);
        y += 26;
      }

      // ── Footer summary strip ──
      y = Math.max(y + 10, doc.page.height - 180);
      doc.roundedRect(left, y, W, 120, 10).fill(CARD);
      doc.roundedRect(left, y, W, 120, 10).lineWidth(0.8).stroke(LINE);
      const colW = W / 2;
      const row = (col: 0 | 1, i: number, label: string, val: string, valColor = INK) => {
        const rx = left + 20 + col * colW, ry = y + 18 + i * 24;
        doc.font("th").fontSize(10).fillColor(MUTE).text(label, rx, ry, { width: colW - 60 });
        doc.font("th-b").fontSize(11).fillColor(valColor).text(val, rx, ry, { width: colW - 40, align: "right" });
      };
      row(0, 0, "ภาษีมูลค่าเพิ่มค้างจ่าย (VAT)", ov.vatRegistered ? `${money2(ov.tax.vatPayable)} บาท` : "ไม่จด VAT");
      row(0, 1, "ภาษีหัก ณ ที่จ่าย รอนำส่ง", `${money2(ov.payables.whtUnpaid)} บาท`);
      row(0, 2, "ประกันสังคม รอนำส่ง", `${money2(ov.payables.ssoUnpaid)} บาท`);
      row(1, 0, `ยอดขายสะสมทั้งปี (${ov.ytd.monthsElapsed} เดือน)`, `${money(ov.ytd.sales)} บาท`);
      row(1, 1, "กำไรสะสมทั้งปี", `${money(ov.ytd.net)} บาท`, ov.ytd.net >= 0 ? GREEN : RED);
      row(1, 2, "ประมาณการภาษีเงินได้นิติบุคคล", `${money(ov.ytd.incomeTaxEst.tax)} บาท`);

      doc.font("th").fontSize(8).fillColor(MUTE)
        .text(`ออกรายงานเมื่อ ${new Date().toLocaleString("th-TH")} · IKIGAI OS`, left, doc.page.height - 40, { width: W, align: "center" });

      doc.end();
    } catch (e) { reject(e); }
  });
}
