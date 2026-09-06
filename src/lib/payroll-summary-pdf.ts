// PDF renderer for the payroll monthly summary document (owner 2026-09-06).
// A4 landscape via pdfkit + the embedded LINE Seed Sans TH TTF (same setup as
// svc-summary-pdf.ts). One block per section (company/branch): a header, the
// pay-round list (รอบจ่าย) for reconciliation, then the employee table with the
// deduction columns (ปกส./ภาษี/ประกันกลุ่ม) shown as red negatives.

import PDFDocument from "pdfkit";
import path from "node:path";
import type { PayrollSummaryDoc, DocSection, EmpDocRow } from "./payroll-summary-doc";

const FONT_REG = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Regular.ttf");
const FONT_BOLD = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Bold.ttf");
const baht = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const deduct = (n: number) => (n > 0 ? "−" + baht(n) : "-");

const RED = "#a32d2d";
const GREEN = "#0f6e56";
const INK = "#281a0e";

export function generatePayrollSummaryPdf(
  d: PayrollSummaryDoc, generatedLabel: string, note?: string | null
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36 });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      doc.registerFont("th", FONT_REG);
      doc.registerFont("th-b", FONT_BOLD);

      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const contentW = right - left;
      const bottom = doc.page.height - doc.page.margins.bottom;
      let y = doc.page.margins.top;

      // Every cell stays on ONE line. NOTE: pdfkit's `lineBreak:false` does NOT
      // reliably prevent wrapping when the text is only slightly wider than the
      // column (it wrapped a 97pt branch name in a 94pt box), which used to make
      // rows overlap. Bounding `height` to a single line + `ellipsis` truncates
      // the overflow with "…" instead — numbers that fit are unaffected.
      const cell = (text: string, x: number, w: number, align: "left" | "right",
        opts: { font?: "th" | "th-b"; size?: number; color?: string } = {}) => {
        const size = opts.size ?? 9;
        doc.font(opts.font ?? "th").fontSize(size).fillColor(opts.color ?? "#333");
        doc.text(text, x + 3, y, { width: w - 6, align, lineBreak: false, height: size * 1.6, ellipsis: true });
      };
      const hr = (color = "#bbb", w = 0.8) => {
        doc.moveTo(left, y).lineTo(right, y).strokeColor(color).lineWidth(w).stroke(); y += 6;
      };
      const ensure = (need: number) => { if (y + need > bottom) { doc.addPage(); y = doc.page.margins.top; } };

      // ── Document header ─────────────────────────────────────────
      doc.font("th-b").fontSize(17).fillColor(INK).text("สรุปค่าตอบแทนรายเดือน", left, y);
      y = doc.y + 2;
      doc.font("th").fontSize(10).fillColor("#a06820").text(`เดือนจ่าย ${d.monthLabel}`, left, y); y = doc.y + 1;
      doc.font("th").fontSize(9).fillColor("#555")
        .text(`ขอบเขต: ${d.scopeLabel}  ·  เซอร์วิสชาร์จของเดือน ${d.svcMonthLabel}  ·  ออกเอกสาร ${generatedLabel}`, left, y);
      y = doc.y;
      if (note && note.trim()) {
        doc.font("th").fontSize(9).fillColor("#333").text(`หมายเหตุ: ${note.trim()}`, left, y + 1, { width: contentW });
        y = doc.y;
      }
      doc.font("th").fontSize(7.5).fillColor("#999")
        .text("คอลัมน์ที่มี (หัก) เป็นรายการหัก แสดงเป็นค่าติดลบสีแดง · เอกสารภายในสำหรับสำนักงานบัญชี", left, y + 2);
      y = doc.y + 8;

      const numW = 78, cntW = 40;
      const nameW = contentW - (7 * numW + cntW);
      const cols: Array<{ label: string; w: number }> = [
        { label: "ชื่อ", w: nameW },
        { label: "ค่าตอบแทน", w: numW },
        { label: "เซอร์วิสชาร์จ", w: numW },
        { label: "รวมรายรับ", w: numW },
        { label: "ปกส. (หัก)", w: numW },
        { label: "ภาษี (หัก)", w: numW },
        { label: "ประกันกลุ่ม (หัก)", w: numW },
        { label: "รวมรับจริง", w: numW },
        { label: "รอบ", w: cntW }
      ];
      const cX = (i: number) => left + cols.slice(0, i).reduce((s, c) => s + c.w, 0);
      const tableHead = () => {
        cols.forEach((c, i) => cell(c.label, cX(i), c.w, i === 0 ? "left" : "right",
          { font: "th-b", size: 8.5, color: INK }));
        y += 15;
      };

      const drawRow = (r: EmpDocRow) => {
        doc.font("th").fontSize(9);
        const nameH = doc.heightOfString(r.name, { width: nameW - 6 });
        const subText = `${r.empTypeLabel}${r.taxModeLabel ? ` · ${r.taxModeLabel}` : ""} · ${r.homeBranch}`;
        doc.font("th").fontSize(7.5);
        const subH = doc.heightOfString(subText, { width: nameW - 6 });
        const rowH = Math.max(nameH + subH + 4, 20);
        if (y + rowH > bottom - 24) { doc.addPage(); y = doc.page.margins.top; tableHead(); hr("#eee", 0.5); }
        const top = y;
        cell(baht(r.comp), cX(1), numW, "right", { size: 9 });
        cell(baht(r.svcGross), cX(2), numW, "right", { size: 9, color: r.svcGross > 0 ? "#6d28d9" : "#999" });
        cell(baht(r.income), cX(3), numW, "right", { size: 9, font: "th-b" });
        cell(deduct(r.sso), cX(4), numW, "right", { size: 9, color: r.sso > 0 ? RED : "#999" });
        cell(deduct(r.tax), cX(5), numW, "right", { size: 9, color: r.tax > 0 ? RED : "#999" });
        cell(deduct(r.gi), cX(6), numW, "right", { size: 9, color: r.gi > 0 ? RED : "#999" });
        cell(baht(r.take), cX(7), numW, "right", { size: 9, font: "th-b", color: r.take >= 0 ? GREEN : RED });
        cell(String(r.periodCount || 0), cX(8), cntW, "right", { size: 9, color: "#777" });
        doc.font("th").fontSize(9).fillColor("#222").text(r.name, cX(0) + 3, top, { width: nameW - 6 });
        doc.font("th").fontSize(7.5).fillColor("#999").text(subText, cX(0) + 3, top + nameH + 1, { width: nameW - 6 });
        y = top + rowH;
        doc.moveTo(left, y).lineTo(right, y).strokeColor("#f0f0f0").lineWidth(0.5).stroke(); y += 3;
      };

      const drawSection = (s: DocSection) => {
        ensure(90);
        // Section header.
        doc.font("th-b").fontSize(13).fillColor(INK).text(s.title, left, y); y = doc.y + 1;
        const meta: string[] = [];
        if (s.taxId) meta.push(`เลขผู้เสียภาษี ${s.taxId}`);
        if (s.address) meta.push(s.address);
        if (meta.length) { doc.font("th").fontSize(8).fillColor("#888").text(meta.join("  ·  "), left, y, { width: contentW }); y = doc.y; }
        y += 4;

        // Pay-round block.
        doc.font("th-b").fontSize(9.5).fillColor("#a06820").text("รอบจ่ายที่กระทบยอดในเดือนนี้", left, y); y = doc.y + 3;
        if (s.payRounds.length === 0) {
          doc.font("th").fontSize(8.5).fillColor("#999").text("— ไม่มีรอบจ่ายในเดือนนี้ (มีเฉพาะเซอร์วิสชาร์จ) —", left, y); y = doc.y + 4;
        } else {
          // สาขา gets the slack — prod branch names ("NAMA PASTA SRIRACHA") are
          // long. The other columns are sized to their actual content.
          const rc: Array<{ label: string; w: number; align: "left" | "right" }> = [
            { label: "ประเภทรอบ", w: 110, align: "left" },
            { label: "ช่วงงวด", w: 125, align: "left" },
            { label: "วันจ่าย", w: 70, align: "left" },
            { label: "สถานะ", w: 65, align: "left" },
            { label: "สาขา", w: contentW - 110 - 125 - 70 - 65 - 85 - 85, align: "left" },
            { label: "ยอดจ่ายรวม", w: 85, align: "right" },
            { label: "ยอดสุทธิ", w: 85, align: "right" }
          ];
          const rX = (i: number) => left + rc.slice(0, i).reduce((s2, c) => s2 + c.w, 0);
          rc.forEach((c, i) => cell(c.label, rX(i), c.w, c.align, { font: "th-b", size: 8, color: "#555" }));
          y += 13;
          for (const p of s.payRounds) {
            ensure(14);
            cell(p.cycleLabel, rX(0), rc[0].w, "left", { size: 8 });
            cell(`${p.periodStart} – ${p.periodEnd}`, rX(1), rc[1].w, "left", { size: 8 });
            cell(p.payDate, rX(2), rc[2].w, "left", { size: 8 });
            cell(p.statusLabel, rX(3), rc[3].w, "left", { size: 8 });
            cell(p.branchName ?? "", rX(4), rc[4].w, "left", { size: 8 });
            cell(baht(p.gross), rX(5), rc[5].w, "right", { size: 8 });
            cell(baht(p.net), rX(6), rc[6].w, "right", { size: 8, color: GREEN });
            y += 12;
          }
          y += 3;
        }

        // Employee table.
        hr("#ddd", 0.5); tableHead(); hr("#eee", 0.5);
        for (const r of s.rows) drawRow(r);
        // Section totals.
        ensure(24);
        hr("#bbb", 0.8);
        const t = s.totals;
        cell(`รวม ${s.rows.length} คน`, cX(0), nameW, "left", { font: "th-b", color: INK });
        cell(baht(t.comp), cX(1), numW, "right", { font: "th-b", color: INK });
        cell(baht(t.svcGross), cX(2), numW, "right", { font: "th-b", color: "#6d28d9" });
        cell(baht(t.income), cX(3), numW, "right", { font: "th-b", color: INK });
        cell(deduct(t.sso), cX(4), numW, "right", { font: "th-b", color: RED });
        cell(deduct(t.tax), cX(5), numW, "right", { font: "th-b", color: RED });
        cell(deduct(t.gi), cX(6), numW, "right", { font: "th-b", color: RED });
        cell(baht(t.take), cX(7), numW, "right", { font: "th-b", color: GREEN });
        y += 18;
      };

      d.sections.forEach((s, i) => {
        if (i > 0) { doc.addPage(); y = doc.page.margins.top; }
        drawSection(s);
      });

      // Grand total (multi-section).
      if (d.sections.length > 1) {
        ensure(120);
        y += 6; hr("#bbb", 0.8);
        doc.font("th-b").fontSize(12).fillColor(INK).text("รวมทั้งหมด (ทุกส่วน)", left, y); y = doc.y + 6;
        const g = d.grand;
        const pairs: Array<[string, string, string?]> = [
          ["ค่าตอบแทน", baht(g.comp)],
          ["เซอร์วิสชาร์จ", baht(g.svcGross), "#6d28d9"],
          ["รวมรายรับ", baht(g.income), INK],
          ["ประกันสังคม (หัก)", deduct(g.sso), RED],
          ["ภาษี ณ ที่จ่าย (หัก)", deduct(g.tax), RED],
          ["ประกันกลุ่ม (หัก)", deduct(g.gi), RED],
          ["รวมรับจริง", baht(g.take), GREEN]
        ];
        for (const [label, value, color] of pairs) {
          ensure(18);
          doc.font("th").fontSize(10).fillColor("#333").text(label, left + 4, y, { width: 280, lineBreak: false });
          doc.font("th-b").fontSize(10).fillColor(color ?? INK).text(value, left + 284, y, { width: 140, align: "right" });
          y += 17;
        }
      }

      doc.end();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
