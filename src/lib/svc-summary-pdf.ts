// Company Service-Charge summary PDF for the accounting office (owner 2026-08-20).
// A4 landscape, server-side via pdfkit + the embedded LINE Seed Sans TH TTF (same
// setup as revshare-statement-pdf.ts / inventa-po-pdf.ts) so Thai shapes
// correctly. pdfkit is marked external in next.config.js.
//
// Three sections: (A) company totals across all branches, (B) per-branch split,
// (C) per-person distribution showing the full deduction chain
//   ส่วนแบ่ง → หักค่าอาหาร(คูปอง) → ก่อนภาษี → หัก ณ ที่จ่าย → หักประกันกลุ่ม → จ่ายสุทธิ
// — enough for the accountant to file ภ.ง.ด. and post the payout. Rows are laid
// out at a measured fixed height so nothing overlaps and the header repeats on
// each page.

import PDFDocument from "pdfkit";
import path from "node:path";

export type SvcPdfData = {
  company: { name: string; taxId: string | null; address: string | null };
  monthLabel: string;        // "สิงหาคม 2569"
  shared: boolean;           // รวมกอง on/off
  payoutDate: string;        // YYYY-MM-DD
  generatedLabel: string;    // "20 ส.ค. 2569 14:32" (computed by the caller — no Date in lib)
  totals: {
    collected: number; staffPool: number; companyPool: number;
    foodClawback: number; otherDeductions: number; wht: number; groupInsurance: number; netPayout: number;
  };
  branches: Array<{
    name: string; collected: number; staffAttributed: number; netAttributed: number; headcount: number;
  }>;
  rows: Array<{
    name: string; typeLabel: string; branchesLabel: string;
    gross: number; foodClawback: number; otherDeductions: number; preTax: number;
    wht: number; groupInsurance: number; net: number; statusLabel: string;
  }>;
};

const FONT_REG = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Regular.ttf");
const FONT_BOLD = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Bold.ttf");
const baht = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const deduct = (n: number) => (n > 0 ? "−" + baht(n) : "-");

type Col = { key: string; w: number; align: "left" | "right" };

export function generateSvcSummaryPdf(d: SvcPdfData): Promise<Buffer> {
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

      const hr = (color = "#bbb", w = 0.8) => {
        doc.moveTo(left, y).lineTo(right, y).strokeColor(color).lineWidth(w).stroke(); y += 6;
      };
      // Right-aligned cell text within a column box starting at x.
      const cell = (text: string, x: number, w: number, align: "left" | "right", opts: { font?: "th" | "th-b"; size?: number; color?: string } = {}) => {
        doc.font(opts.font ?? "th").fontSize(opts.size ?? 9).fillColor(opts.color ?? "#333");
        doc.text(text, x + 3, y, { width: w - 6, align, lineBreak: false });
      };

      // ── Header ──────────────────────────────────────────────────
      doc.font("th-b").fontSize(17).fillColor("#281a0e").text("ใบสรุปเซอร์วิสชาร์จ (รวมทั้งบริษัท)", left, y);
      y = doc.y + 2;
      doc.font("th").fontSize(10).fillColor("#a06820").text(`รอบเดือน ${d.monthLabel}`, left, y); y = doc.y + 1;
      doc.font("th").fontSize(9).fillColor("#555").text(d.company.name, left, y); y = doc.y;
      const meta: string[] = [];
      if (d.company.taxId) meta.push(`เลขผู้เสียภาษี ${d.company.taxId}`);
      if (d.company.address) meta.push(d.company.address);
      if (meta.length) { doc.text(meta.join("  ·  "), left, y, { width: contentW }); y = doc.y; }
      doc.fillColor("#888").fontSize(8).text(
        `${d.shared ? "โหมดรวมกอง (แบ่งข้ามสาขาตามชั่วโมง)" : "แยกตามสาขา"}  ·  วันจ่าย ${d.payoutDate}  ·  ออกเอกสาร ${d.generatedLabel}`,
        left, y + 2
      );
      y = doc.y + 10;

      // ── Section A: company totals (two columns) ─────────────────
      hr();
      doc.font("th-b").fontSize(11).fillColor("#281a0e").text("สรุปรวมทั้งบริษัท", left, y); y = doc.y + 5;
      const colW = contentW / 2;
      const aPairs: Array<[string, string, boolean, string?]> = [
        ["ยอดเซอร์วิสชาร์จเก็บได้รวมทุกสาขา", baht(d.totals.collected), true],
        ["ส่วนของพนักงาน (60%)", baht(d.totals.staffPool), false],
        ["ส่วนของบริษัท (40% + ตัดสิทธิ์/คืน)", baht(d.totals.companyPool), false],
        ["หักค่าอาหาร (คูปอง · คืนเข้าบริษัท)", deduct(d.totals.foodClawback), false, "#a32d2d"],
        ["หักรายการอื่นๆ (เช่น ค่าเครื่องดื่ม)", deduct(d.totals.otherDeductions), false, "#a32d2d"],
        ["หักภาษี ณ ที่จ่าย 3% รวม", deduct(d.totals.wht), false, "#a32d2d"],
        ["หักประกันกลุ่มรวม (เจ้าหนี้รอนำส่ง)", deduct(d.totals.groupInsurance), false, "#a32d2d"],
        ["ยอดจ่ายพนักงานสุทธิรวม", baht(d.totals.netPayout), true, "#0f6e56"]
      ];
      const aTop = y;
      aPairs.forEach(([label, value, bold, color], i) => {
        const colX = left + (i % 2) * colW;
        if (i % 2 === 0 && i > 0) y += 0; // rows advance below
        const rowY = aTop + Math.floor(i / 2) * 18;
        doc.font(bold ? "th-b" : "th").fontSize(bold ? 11 : 10).fillColor(color ?? "#281a0e");
        doc.text(label, colX + 4, rowY, { width: colW - 130, lineBreak: false });
        doc.text(value, colX + colW - 130, rowY, { width: 120, align: "right" });
      });
      y = aTop + Math.ceil(aPairs.length / 2) * 18 + 6;

      // ── Section B: per-branch split ─────────────────────────────
      if (y + 70 > bottom) { doc.addPage(); y = doc.page.margins.top; }
      doc.font("th-b").fontSize(11).fillColor("#281a0e").text("แยกตามสาขา", left, y); y = doc.y + 4;
      const bNumW = 120;
      const bCols: Array<{ label: string } & Col> = [
        { key: "name", label: "สาขา", w: contentW - 4 * bNumW, align: "left" },
        { key: "collected", label: "SVC เก็บได้", w: bNumW, align: "right" },
        { key: "staff", label: "ส่วนพนักงาน", w: bNumW, align: "right" },
        { key: "net", label: "จ่ายสุทธิ", w: bNumW, align: "right" },
        { key: "hc", label: "จำนวนคน", w: bNumW, align: "right" }
      ];
      const bX = (i: number) => left + bCols.slice(0, i).reduce((s, c) => s + c.w, 0);
      const bHead = () => { bCols.forEach((c, i) => cell(c.label, bX(i), c.w, c.align, { font: "th-b", size: 9, color: "#281a0e" })); y += 15; };
      hr("#ddd", 0.5); bHead(); hr("#eee", 0.5);
      for (const b of d.branches) {
        if (y + 16 > bottom - 30) { doc.addPage(); y = doc.page.margins.top; bHead(); hr("#eee", 0.5); }
        cell(b.name, bX(0), bCols[0].w, "left");
        cell(baht(b.collected), bX(1), bCols[1].w, "right");
        cell(baht(b.staffAttributed), bX(2), bCols[2].w, "right");
        cell(baht(b.netAttributed), bX(3), bCols[3].w, "right");
        cell(String(b.headcount), bX(4), bCols[4].w, "right");
        y += 15;
      }
      hr("#bbb", 0.8);
      cell("รวม", bX(0), bCols[0].w, "left", { font: "th-b", color: "#281a0e" });
      cell(baht(d.branches.reduce((s, b) => s + b.collected, 0)), bX(1), bCols[1].w, "right", { font: "th-b", color: "#281a0e" });
      cell(baht(d.branches.reduce((s, b) => s + b.staffAttributed, 0)), bX(2), bCols[2].w, "right", { font: "th-b", color: "#281a0e" });
      cell(baht(d.branches.reduce((s, b) => s + b.netAttributed, 0)), bX(3), bCols[3].w, "right", { font: "th-b", color: "#281a0e" });
      y += 16;
      doc.font("th").fontSize(7.5).fillColor("#999")
        .text("* ส่วนพนักงาน/จ่ายสุทธิ ปันตามสัดส่วนที่แต่ละคนได้จากสาขานั้น (ภาษี/ประกันกลุ่มหักที่ระดับบุคคล)", left, y);
      y = doc.y + 10;

      // ── Section C: per-person distribution ──────────────────────
      if (y + 60 > bottom) { doc.addPage(); y = doc.page.margins.top; }
      doc.font("th-b").fontSize(11).fillColor("#281a0e").text("รายบุคคล", left, y); y = doc.y + 4;
      const numW = 76;
      const statusW = 78;
      const cCols: Array<{ label: string } & Col> = [
        { key: "name", label: "ชื่อ", w: contentW - 6 * numW - statusW, align: "left" },
        { key: "gross", label: "ส่วนแบ่ง", w: numW, align: "right" },
        { key: "food", label: "หักค่าอาหาร", w: numW, align: "right" },
        { key: "other", label: "หักอื่นๆ", w: numW, align: "right" },
        { key: "pretax", label: "ก่อนภาษี", w: numW, align: "right" },
        { key: "wht", label: "หัก ณ ที่จ่าย", w: numW, align: "right" },
        { key: "gi", label: "ประกันกลุ่ม", w: numW, align: "right" },
        { key: "net", label: "จ่ายสุทธิ", w: statusW, align: "right" }
      ];
      // (status shown as a small tag on the name sub-line to keep columns readable)
      const cX = (i: number) => left + cCols.slice(0, i).reduce((s, c) => s + c.w, 0);
      const cHead = () => {
        cCols.forEach((c, i) => cell(c.label, cX(i), c.w, c.align, { font: "th-b", size: 8.5, color: "#281a0e" }));
        y += 16;
      };
      hr("#ddd", 0.5); cHead(); hr("#eee", 0.5);

      const nameW = cCols[0].w;
      for (const p of d.rows) {
        // Measure the name + sub-line block so the row height is exact (no overlap).
        doc.font("th").fontSize(9);
        const nameH = doc.heightOfString(p.name, { width: nameW - 6 });
        const subText = `${p.typeLabel} · ${p.branchesLabel}${p.statusLabel !== "ได้รับ" ? ` · ${p.statusLabel}` : ""}`;
        doc.font("th").fontSize(7.5);
        const subH = doc.heightOfString(subText, { width: nameW - 6 });
        const rowH = Math.max(nameH + subH + 4, 20);

        if (y + rowH > bottom - 26) { doc.addPage(); y = doc.page.margins.top; cHead(); hr("#eee", 0.5); }

        const rowTop = y;
        // numbers on the top baseline of the row
        cell(baht(p.gross), cX(1), cCols[1].w, "right", { size: 9 });
        cell(deduct(p.foodClawback), cX(2), cCols[2].w, "right", { size: 9, color: p.foodClawback > 0 ? "#a32d2d" : "#999" });
        cell(deduct(p.otherDeductions), cX(3), cCols[3].w, "right", { size: 9, color: p.otherDeductions > 0 ? "#a32d2d" : "#999" });
        cell(baht(p.preTax), cX(4), cCols[4].w, "right", { size: 9 });
        cell(deduct(p.wht), cX(5), cCols[5].w, "right", { size: 9, color: p.wht > 0 ? "#a32d2d" : "#999" });
        cell(deduct(p.groupInsurance), cX(6), cCols[6].w, "right", { size: 9, color: p.groupInsurance > 0 ? "#a32d2d" : "#999" });
        cell(baht(p.net), cX(7), cCols[7].w, "right", { font: "th-b", size: 9, color: p.net > 0 ? "#0f6e56" : "#a32d2d" });
        // name + sub-line in the first column only
        doc.font("th").fontSize(9).fillColor("#222").text(p.name, cX(0) + 3, rowTop, { width: nameW - 6 });
        doc.font("th").fontSize(7.5).fillColor(p.statusLabel.startsWith("ตัดสิทธิ์") ? "#a32d2d" : "#999")
          .text(subText, cX(0) + 3, rowTop + nameH + 1, { width: nameW - 6 });

        y = rowTop + rowH;
        doc.moveTo(left, y).lineTo(right, y).strokeColor("#f0f0f0").lineWidth(0.5).stroke(); y += 3;
      }

      if (y + 20 > bottom - 20) { doc.addPage(); y = doc.page.margins.top; cHead(); hr("#eee", 0.5); }
      hr("#bbb", 0.8);
      cell(`รวม ${d.rows.length} คน`, cX(0), cCols[0].w, "left", { font: "th-b", color: "#281a0e" });
      cell(baht(d.rows.reduce((s, r) => s + r.gross, 0)), cX(1), cCols[1].w, "right", { font: "th-b", color: "#281a0e" });
      cell(deduct(d.totals.foodClawback), cX(2), cCols[2].w, "right", { font: "th-b", color: "#a32d2d" });
      cell(deduct(d.totals.otherDeductions), cX(3), cCols[3].w, "right", { font: "th-b", color: "#a32d2d" });
      cell(baht(d.rows.reduce((s, r) => s + r.preTax, 0)), cX(4), cCols[4].w, "right", { font: "th-b", color: "#281a0e" });
      cell(deduct(d.totals.wht), cX(5), cCols[5].w, "right", { font: "th-b", color: "#a32d2d" });
      cell(deduct(d.totals.groupInsurance), cX(6), cCols[6].w, "right", { font: "th-b", color: "#a32d2d" });
      cell(baht(d.totals.netPayout), cX(7), cCols[7].w, "right", { font: "th-b", color: "#0f6e56" });
      y += 14;

      // Footer flows right after the totals (pinning it to the page bottom can
      // strand it on an extra blank page). Keep it on the current page.
      if (y + 16 > bottom) { doc.addPage(); y = doc.page.margins.top; }
      doc.font("th").fontSize(8).fillColor("#999").text(
        "เอกสารสรุปภายในสำหรับสำนักงานบัญชี · ไม่ใช่เอกสารทางภาษีอย่างเป็นทางการ",
        left, y, { width: contentW, align: "center" }
      );
      doc.end();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
