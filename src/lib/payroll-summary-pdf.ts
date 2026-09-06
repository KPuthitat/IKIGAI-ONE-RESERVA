// PDF renderer for the payroll monthly summary document (owner 2026-09-06,
// Phase 1). A4 landscape via pdfkit + LINE Seed Sans TH. คำนวณระดับบริษัท ·
// แยกหัวข้อสาขา: per company → per branch heading → per-round breakdown
// (ยอดก่อนหัก → หัก → สุทธิ) → final per-person rollup. Deduction columns show
// as red negatives.

import PDFDocument from "pdfkit";
import path from "node:path";
import type { PayrollSummaryDoc, CompanyDoc, BranchBlock, PayRoundGroup, EmpDocRow, DocTotals } from "./payroll-summary-doc";

const FONT_REG = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Regular.ttf");
const FONT_BOLD = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Bold.ttf");
const baht = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const deduct = (n: number) => (n > 0 ? "−" + baht(n) : "-");

const RED = "#a32d2d";
const GREEN = "#0f6e56";
const INK = "#281a0e";
const VIOLET = "#6d28d9";

export function generatePayrollSummaryPdf(
  d: PayrollSummaryDoc, generatedLabel: string, note?: string | null
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 32 });
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

      // Single-line cell (see the overlap fix): lineBreak:false alone doesn't
      // stop pdfkit wrapping near-fit text, so bound height + ellipsis.
      const cell = (text: string, x: number, w: number, align: "left" | "right",
        opts: { font?: "th" | "th-b"; size?: number; color?: string } = {}) => {
        const size = opts.size ?? 9;
        doc.font(opts.font ?? "th").fontSize(size).fillColor(opts.color ?? "#333");
        doc.text(text, x + 3, y, { width: w - 6, align, lineBreak: false, height: size * 1.6, ellipsis: true });
      };
      const hr = (color = "#bbb", w = 0.8) => { doc.moveTo(left, y).lineTo(right, y).strokeColor(color).lineWidth(w).stroke(); y += 6; };
      const ensure = (need: number) => { if (y + need > bottom) { doc.addPage(); y = doc.page.margins.top; } };

      // ── Document header ─────────────────────────────────────────
      doc.font("th-b").fontSize(16).fillColor(INK).text("สรุปค่าตอบแทนรายเดือน", left, y); y = doc.y + 1;
      doc.font("th").fontSize(9).fillColor("#a06820").text("คำนวณระดับบริษัท · แยกหัวข้อสาขา", left, y); y = doc.y + 1;
      doc.font("th").fontSize(9).fillColor("#555")
        .text(`ขอบเขต: ${d.scopeLabel}  ·  เดือนจ่าย ${d.monthLabel}  ·  เซอร์วิสชาร์จของเดือน ${d.svcMonthLabel}  ·  ออกเอกสาร ${generatedLabel}`, left, y);
      y = doc.y;
      if (note && note.trim()) { doc.font("th").fontSize(9).fillColor("#333").text(`หมายเหตุ: ${note.trim()}`, left, y + 1, { width: contentW }); y = doc.y; }
      doc.font("th").fontSize(7.5).fillColor("#999")
        .text("คอลัมน์ที่มี (หัก) แสดงเป็นค่าติดลบสีแดง · เซอร์วิสชาร์จคำนวณระดับบริษัท · เอกสารภายในสำหรับสำนักงานบัญชี", left, y + 2);
      y = doc.y + 8;

      // ── Round member table (ก่อนหัก → หัก → สุทธิ) ────────────────
      const rmNum = 95;
      const rmName = contentW - 150 - 3 * rmNum;
      const rmCols = [
        { label: "ชื่อ-นามสกุล", w: rmName, align: "left" as const },
        { label: "สังกัด", w: 150, align: "left" as const },
        { label: "ยอดก่อนหัก", w: rmNum, align: "right" as const },
        { label: "ยอดหัก", w: rmNum, align: "right" as const },
        { label: "ยอดสุทธิ", w: rmNum, align: "right" as const }
      ];
      const rmX = (i: number) => left + rmCols.slice(0, i).reduce((s, c) => s + c.w, 0);
      const rmHead = () => { rmCols.forEach((c, i) => cell(c.label, rmX(i), c.w, c.align, { font: "th-b", size: 8.5, color: "#555" })); y += 14; };

      const drawRound = (g: PayRoundGroup) => {
        ensure(60);
        doc.font("th-b").fontSize(9.5).fillColor("#a06820")
          .text(`รอบจ่าย: ${g.info.cycleLabel} · งวด ${g.info.periodStart} – ${g.info.periodEnd} · จ่าย ${g.info.payDate} · ${g.info.statusLabel}`, left + 6, y, { width: contentW - 6 });
        y = doc.y + 2;
        hr("#e5e5e5", 0.5); rmHead(); hr("#eee", 0.5);
        for (const m of g.members) {
          ensure(16);
          cell(m.name, rmX(0), rmCols[0].w, "left", { size: 8.5 });
          cell(m.homeBranch, rmX(1), rmCols[1].w, "left", { size: 8, color: "#888" });
          cell(baht(m.before), rmX(2), rmNum, "right", { size: 8.5 });
          cell(deduct(m.deduction), rmX(3), rmNum, "right", { size: 8.5, color: m.deduction > 0 ? RED : "#999" });
          cell(baht(m.net), rmX(4), rmNum, "right", { size: 8.5, color: GREEN });
          y += 13;
        }
        if (g.members.length === 0) { cell("— ไม่มีรายการจ่ายในรอบนี้ —", rmX(0), contentW, "left", { size: 8, color: "#999" }); y += 13; }
        ensure(16); hr("#e5e5e5", 0.5);
        cell("รวมรอบ", rmX(0), rmCols[0].w, "left", { font: "th-b", color: INK, size: 8.5 });
        cell(baht(g.before), rmX(2), rmNum, "right", { font: "th-b", size: 8.5 });
        cell(deduct(g.deduction), rmX(3), rmNum, "right", { font: "th-b", size: 8.5, color: RED });
        cell(baht(g.net), rmX(4), rmNum, "right", { font: "th-b", size: 8.5, color: GREEN });
        y += 16;
      };

      // ── Rollup table (final per-person) ─────────────────────────
      const ruNum = 66;
      const ruName = contentW - 9 * ruNum;
      const ruCols = [
        { label: "ชื่อ", w: ruName, align: "left" as const },
        { label: "ค่าตอบแทน", w: ruNum, align: "right" as const },
        { label: "SVC", w: ruNum, align: "right" as const },
        { label: "ก่อนหัก", w: ruNum, align: "right" as const },
        { label: "ปกส.(หัก)", w: ruNum, align: "right" as const },
        { label: "ภาษี(หัก)", w: ruNum, align: "right" as const },
        { label: "กลุ่ม(หัก)", w: ruNum, align: "right" as const },
        { label: "อื่นๆ(หัก)", w: ruNum, align: "right" as const },
        { label: "รวมหัก", w: ruNum, align: "right" as const },
        { label: "สุทธิ", w: ruNum, align: "right" as const }
      ];
      const ruX = (i: number) => left + ruCols.slice(0, i).reduce((s, c) => s + c.w, 0);
      const ruHead = () => { ruCols.forEach((c, i) => cell(c.label, ruX(i), c.w, c.align, { font: "th-b", size: 8, color: INK })); y += 14; };
      const ruTotalsRow = (label: string, t: DocTotals) => {
        cell(label, ruX(0), ruName, "left", { font: "th-b", color: INK, size: 8.5 });
        cell(baht(t.comp), ruX(1), ruNum, "right", { font: "th-b", size: 8.5 });
        cell(baht(t.svcGross), ruX(2), ruNum, "right", { font: "th-b", size: 8.5, color: VIOLET });
        cell(baht(t.income), ruX(3), ruNum, "right", { font: "th-b", size: 8.5 });
        cell(deduct(t.sso), ruX(4), ruNum, "right", { font: "th-b", size: 8.5, color: RED });
        cell(deduct(t.tax), ruX(5), ruNum, "right", { font: "th-b", size: 8.5, color: RED });
        cell(deduct(t.gi), ruX(6), ruNum, "right", { font: "th-b", size: 8.5, color: RED });
        cell(deduct(t.other), ruX(7), ruNum, "right", { font: "th-b", size: 8.5, color: RED });
        cell(deduct(t.deduction), ruX(8), ruNum, "right", { font: "th-b", size: 8.5, color: RED });
        cell(baht(t.take), ruX(9), ruNum, "right", { font: "th-b", size: 8.5, color: GREEN });
        y += 15;
      };

      const drawRollupRow = (r: EmpDocRow) => {
        doc.font("th").fontSize(8.5);
        const nameH = doc.heightOfString(r.name, { width: ruName - 6 });
        const sub = `${r.empTypeLabel}${r.taxModeLabel ? ` · ${r.taxModeLabel}` : ""}`;
        doc.font("th").fontSize(7);
        const subH = doc.heightOfString(sub, { width: ruName - 6 });
        const rowH = Math.max(nameH + subH + 3, 18);
        if (y + rowH > bottom - 20) { doc.addPage(); y = doc.page.margins.top; ruHead(); hr("#eee", 0.5); }
        const top = y;
        cell(baht(r.comp), ruX(1), ruNum, "right", { size: 8.5 });
        cell(baht(r.svcGross), ruX(2), ruNum, "right", { size: 8.5, color: r.svcGross > 0 ? VIOLET : "#999" });
        cell(baht(r.income), ruX(3), ruNum, "right", { size: 8.5, font: "th-b" });
        cell(deduct(r.sso), ruX(4), ruNum, "right", { size: 8.5, color: r.sso > 0 ? RED : "#999" });
        cell(deduct(r.tax), ruX(5), ruNum, "right", { size: 8.5, color: r.tax > 0 ? RED : "#999" });
        cell(deduct(r.gi), ruX(6), ruNum, "right", { size: 8.5, color: r.gi > 0 ? RED : "#999" });
        cell(deduct(r.other), ruX(7), ruNum, "right", { size: 8.5, color: r.other > 0 ? RED : "#999" });
        cell(deduct(r.deduction), ruX(8), ruNum, "right", { size: 8.5, color: r.deduction > 0 ? RED : "#999" });
        cell(baht(r.take), ruX(9), ruNum, "right", { size: 8.5, font: "th-b", color: r.take >= 0 ? GREEN : RED });
        doc.font("th").fontSize(8.5).fillColor("#222").text(r.name, ruX(0) + 3, top, { width: ruName - 6 });
        doc.font("th").fontSize(7).fillColor("#999").text(sub, ruX(0) + 3, top + nameH + 1, { width: ruName - 6 });
        y = top + rowH;
        doc.moveTo(left, y).lineTo(right, y).strokeColor("#f2f2f2").lineWidth(0.5).stroke(); y += 3;
      };

      const drawBranch = (bl: BranchBlock) => {
        ensure(70);
        // Accent bar as the branch bullet (a glyph like ◆ isn't in the Thai font).
        doc.rect(left, y + 1, 3, 12).fillColor("#0369a1").fill();
        doc.font("th-b").fontSize(12).fillColor(INK).text(`สาขา: ${bl.branchName}`, left + 9, y); y = doc.y + 4;
        for (const g of bl.roundGroups) drawRound(g);
        if (bl.roundGroups.length === 0) { doc.font("th").fontSize(8.5).fillColor("#999").text("(ไม่มีรอบจ่ายในเดือนนี้ — มีเฉพาะเซอร์วิสชาร์จ)", left + 6, y); y = doc.y + 6; }
        // Final per-person rollup for this branch.
        ensure(50);
        doc.font("th-b").fontSize(9.5).fillColor("#0369a1").text("สรุปรวมต่อคน (ทั้งเดือน · รวมเซอร์วิสชาร์จระดับบริษัท)", left + 6, y); y = doc.y + 3;
        hr("#ddd", 0.5); ruHead(); hr("#eee", 0.5);
        for (const r of bl.rollup) drawRollupRow(r);
        ensure(18); hr("#bbb", 0.8); ruTotalsRow(`รวมสาขา ${bl.branchName}`, bl.totals); y += 6;
      };

      const drawCompany = (c: CompanyDoc, idx: number) => {
        if (idx > 0) { doc.addPage(); y = doc.page.margins.top; }
        doc.font("th-b").fontSize(14).fillColor(INK).text(`บริษัท: ${c.name}`, left, y); y = doc.y + 1;
        const meta: string[] = [];
        if (c.taxId) meta.push(`เลขผู้เสียภาษี ${c.taxId}`);
        if (c.address) meta.push(c.address);
        if (meta.length) { doc.font("th").fontSize(8).fillColor("#888").text(meta.join("  ·  "), left, y, { width: contentW }); y = doc.y; }
        y += 6;
        for (const bl of c.branches) drawBranch(bl);
        ensure(18); hr("#999", 1); ruTotalsRow(`รวมทั้งบริษัท ${c.name}`, c.totals); y += 4;
      };

      d.companies.forEach((c, i) => drawCompany(c, i));

      if (d.companies.length > 1) {
        ensure(24); y += 4; hr("#999", 1);
        ruTotalsRow("รวมทั้งหมด (ทุกบริษัท)", d.grand);
      }

      doc.end();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
