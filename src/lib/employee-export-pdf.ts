// PDF renderer for the employee export (owner 2026-09-07). A4 landscape via
// pdfkit + LINE Seed Sans TH. One company per page-flow; branch (สังกัด) sections
// with a dynamic-width table of the chosen columns. Cells are single-line
// (ellipsis) so many columns never overlap — see the payroll-summary-pdf note.

import PDFDocument from "pdfkit";
import path from "node:path";
import type { EmployeeDoc, EmployeeCell } from "./employee-export";

const FONT_REG = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Regular.ttf");
const FONT_BOLD = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Bold.ttf");
const INK = "#281a0e";

export function generateEmployeePdf(doc: EmployeeDoc, generatedLabel: string, note?: string | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const pdf = new PDFDocument({ size: "A4", layout: "landscape", margin: 28 });
      const chunks: Buffer[] = [];
      pdf.on("data", (c: Buffer) => chunks.push(c));
      pdf.on("end", () => resolve(Buffer.concat(chunks)));
      pdf.on("error", reject);
      pdf.registerFont("th", FONT_REG);
      pdf.registerFont("th-b", FONT_BOLD);

      const left = pdf.page.margins.left;
      const right = pdf.page.width - pdf.page.margins.right;
      const contentW = right - left;
      const bottom = pdf.page.height - pdf.page.margins.bottom;
      let y = pdf.page.margins.top;

      // Column widths: the name column gets more room; the rest share evenly, with
      // a floor so a 30-column pick stays legible (just cramped).
      const n = doc.columns.length;
      const nameW = Math.min(150, Math.max(90, contentW * 0.18));
      const restW = Math.max(46, (contentW - nameW) / Math.max(1, n - 1));
      const colW = doc.columns.map((_, i) => (i === 0 ? nameW : restW));
      const colX = (i: number) => left + colW.slice(0, i).reduce((s, w) => s + w, 0);
      const cell = (text: string, x: number, w: number, opts: { font?: "th" | "th-b"; size?: number; color?: string; align?: "left" | "right" } = {}) => {
        const size = opts.size ?? 7.5;
        pdf.font(opts.font ?? "th").fontSize(size).fillColor(opts.color ?? "#333");
        pdf.text(text, x + 2, y, { width: w - 4, align: opts.align ?? "left", lineBreak: false, height: size * 1.6, ellipsis: true });
      };
      const money = (c: EmployeeCell, kind: string) =>
        kind === "money" && typeof c === "number" ? c.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : String(c ?? "");
      const ensure = (need: number) => { if (y + need > bottom) { pdf.addPage(); y = pdf.page.margins.top; } };
      const headRow = () => {
        doc.columns.forEach((c, i) => cell(c.header, colX(i), colW[i], { font: "th-b", size: 7, color: INK, align: i === 0 ? "left" : (c.kind === "money" ? "right" : "left") }));
        y += 13;
        pdf.moveTo(left, y).lineTo(right, y).strokeColor("#ddd").lineWidth(0.5).stroke(); y += 3;
      };

      // ── Header ──────────────────────────────────────────────
      pdf.font("th-b").fontSize(15).fillColor(INK).text("รายชื่อและข้อมูลพนักงาน", left, y); y = pdf.y + 1;
      pdf.font("th").fontSize(9).fillColor("#555")
        .text(`ขอบเขต: ${doc.scopeLabel}  ·  ${doc.total} คน  ·  ออกเอกสาร ${generatedLabel}`, left, y); y = pdf.y;
      if (note && note.trim()) { pdf.font("th").fontSize(9).fillColor("#333").text(`หมายเหตุ: ${note.trim()}`, left, y + 1, { width: contentW }); y = pdf.y; }
      y += 8;

      if (doc.companies.length === 0) {
        pdf.font("th").fontSize(11).fillColor("#999").text("ไม่มีข้อมูลพนักงานในขอบเขตที่เลือก", left, y);
        pdf.end();
        return;
      }

      doc.companies.forEach((c, ci) => {
        if (ci > 0) { pdf.addPage(); y = pdf.page.margins.top; }
        pdf.font("th-b").fontSize(13).fillColor(INK).text(`บริษัท: ${c.name}`, left, y); y = pdf.y;
        pdf.font("th").fontSize(8).fillColor("#888").text(`${c.count} คน`, left, y); y = pdf.y + 4;
        for (const bl of c.branches) {
          ensure(40);
          pdf.rect(left, y + 1, 3, 11).fillColor("#0369a1").fill();
          pdf.font("th-b").fontSize(11).fillColor(INK).text(`สาขา: ${bl.branchName} (${bl.rows.length} คน)`, left + 9, y); y = pdf.y + 3;
          headRow();
          for (const r of bl.rows) {
            ensure(14);
            r.cells.forEach((cellVal, i) => {
              const col = doc.columns[i];
              cell(money(cellVal, col.kind), colX(i), colW[i], { size: 7.5, align: i === 0 ? "left" : (col.kind === "money" ? "right" : "left") });
            });
            y += 11;
            pdf.moveTo(left, y).lineTo(right, y).strokeColor("#f3f3f3").lineWidth(0.5).stroke(); y += 2;
          }
          y += 6;
        }
      });

      pdf.end();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
