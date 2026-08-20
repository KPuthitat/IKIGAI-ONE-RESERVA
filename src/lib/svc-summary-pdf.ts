// Company Service-Charge summary PDF for the accounting office (owner 2026-08-20).
// A4, server-side via pdfkit + the embedded LINE Seed Sans TH TTF (same setup as
// revshare-statement-pdf.ts / inventa-po-pdf.ts) so Thai shapes correctly. pdfkit
// is marked external in next.config.js.
//
// Three sections: (A) company totals across all branches, (B) per-branch split,
// (C) per-person distribution (name, branches earned from, pre-tax, WHT, group
// insurance, net) — enough for the accountant to file ภ.ง.ด. and post the payout.

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
    wht: number; groupInsurance: number; netPayout: number;
  };
  branches: Array<{
    name: string; collected: number; staffAttributed: number; netAttributed: number; headcount: number;
  }>;
  rows: Array<{
    name: string; typeLabel: string; branchesLabel: string;
    preTax: number; wht: number; groupInsurance: number; net: number; statusLabel: string;
  }>;
};

const FONT_REG = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Regular.ttf");
const FONT_BOLD = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Bold.ttf");
const baht = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function generateSvcSummaryPdf(d: SvcPdfData): Promise<Buffer> {
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
      const contentW = right - left;
      const bottom = doc.page.height - doc.page.margins.bottom;
      let y = doc.page.margins.top;

      // Page-break guard: when the next block would run past the bottom margin,
      // start a fresh page and reset y to the top.
      const ensure = (h: number) => {
        if (y + h > bottom - 20) { doc.addPage(); y = doc.page.margins.top; }
      };
      const hr = (color = "#bbb", w = 0.8) => {
        doc.moveTo(left, y).lineTo(right, y).strokeColor(color).lineWidth(w).stroke(); y += 6;
      };

      // ── Header ──────────────────────────────────────────────────
      doc.font("th-b").fontSize(18).fillColor("#281a0e")
        .text("ใบสรุปเซอร์วิสชาร์จ (รวมทั้งบริษัท)", left, y);
      y = doc.y + 2;
      doc.font("th").fontSize(10).fillColor("#a06820").text(`รอบเดือน ${d.monthLabel}`, left, y);
      y = doc.y + 1;
      doc.font("th").fontSize(9).fillColor("#555").text(d.company.name, left, y);
      y = doc.y;
      if (d.company.taxId) { doc.text(`เลขประจำตัวผู้เสียภาษี ${d.company.taxId}`, left, y); y = doc.y; }
      if (d.company.address) { doc.text(d.company.address, left, y, { width: contentW * 0.7 }); y = doc.y; }
      doc.fillColor("#888").fontSize(8).text(
        `${d.shared ? "โหมดรวมกอง (แบ่งข้ามสาขาตามชั่วโมง)" : "แยกตามสาขา"} · วันจ่าย ${d.payoutDate} · ออกเอกสาร ${d.generatedLabel}`,
        left, y + 2
      );
      y = doc.y + 10;

      // ── Section A: company totals ───────────────────────────────
      hr();
      doc.font("th-b").fontSize(11).fillColor("#281a0e").text("สรุปรวมทั้งบริษัท", left, y); y = doc.y + 4;
      const sumLine = (label: string, value: string, bold = false, color = "#281a0e") => {
        doc.font(bold ? "th-b" : "th").fontSize(bold ? 11 : 10).fillColor(color);
        doc.text(label, left + 4, y, { width: contentW - 160 });
        doc.text(value, right - 160, y, { width: 156, align: "right" });
        y = doc.y + (bold ? 5 : 3);
      };
      sumLine("ยอดเซอร์วิสชาร์จเก็บได้รวมทุกสาขา", baht(d.totals.collected), true);
      sumLine("  ส่วนของพนักงาน (60%)", baht(d.totals.staffPool));
      sumLine("  ส่วนของบริษัท (40% + ที่ถูกตัดสิทธิ์)", baht(d.totals.companyPool));
      sumLine("หักภาษี ณ ที่จ่าย 3% รวม", "−" + baht(d.totals.wht), false, "#a32d2d");
      if (d.totals.groupInsurance > 0)
        sumLine("หักประกันกลุ่มรวม (เจ้าหนี้รอนำส่ง)", "−" + baht(d.totals.groupInsurance), false, "#a32d2d");
      y += 2; hr();
      sumLine("ยอดจ่ายพนักงานสุทธิรวม", baht(d.totals.netPayout), true, "#0f6e56");
      y += 8;

      // ── Section B: per-branch split ─────────────────────────────
      ensure(60);
      doc.font("th-b").fontSize(11).fillColor("#281a0e").text("แยกตามสาขา", left, y); y = doc.y + 4;
      const bCols = [
        { t: "สาขา", w: contentW - 4 * 92, a: "left" as const },
        { t: "SVC เก็บได้", w: 92, a: "right" as const },
        { t: "ส่วนพนักงาน", w: 92, a: "right" as const },
        { t: "จ่ายสุทธิ", w: 92, a: "right" as const },
        { t: "คน", w: 92, a: "right" as const }
      ];
      const bRow = (cells: string[], font: "th" | "th-b", size = 9, color = "#333") => {
        doc.font(font).fontSize(size).fillColor(color);
        let x = left + 4;
        cells.forEach((c, i) => { doc.text(c, x, y, { width: bCols[i].w - 6, align: bCols[i].a }); x += bCols[i].w; });
        y = doc.y + 4;
      };
      hr("#ddd", 0.5);
      bRow(bCols.map((c) => c.t), "th-b", 9, "#281a0e");
      hr("#eee", 0.5);
      for (const b of d.branches) {
        ensure(18);
        bRow([b.name, baht(b.collected), baht(b.staffAttributed), baht(b.netAttributed), String(b.headcount)], "th");
      }
      hr("#bbb", 0.8);
      bRow([
        "รวม",
        baht(d.branches.reduce((s, b) => s + b.collected, 0)),
        baht(d.branches.reduce((s, b) => s + b.staffAttributed, 0)),
        baht(d.branches.reduce((s, b) => s + b.netAttributed, 0)),
        ""
      ], "th-b", 9, "#281a0e");
      doc.font("th").fontSize(7.5).fillColor("#999")
        .text("* ส่วนพนักงาน/จ่ายสุทธิ ปันตามสัดส่วนที่แต่ละคนได้จากสาขานั้น (ภาษี/ประกันกลุ่มหักที่ระดับบุคคล)", left + 4, y);
      y = doc.y + 10;

      // ── Section C: per-person distribution ──────────────────────
      ensure(60);
      doc.font("th-b").fontSize(11).fillColor("#281a0e").text("รายบุคคล", left, y); y = doc.y + 4;
      const nameW = contentW - 5 * 74;
      const cCols = [
        { t: "ชื่อ", w: nameW, a: "left" as const },
        { t: "ก่อนภาษี", w: 74, a: "right" as const },
        { t: "หัก ณ ที่จ่าย", w: 74, a: "right" as const },
        { t: "ประกันกลุ่ม", w: 74, a: "right" as const },
        { t: "สุทธิ", w: 74, a: "right" as const },
        { t: "สถานะ", w: 74, a: "right" as const }
      ];
      const cRowHead = () => {
        doc.font("th-b").fontSize(8.5).fillColor("#281a0e");
        let x = left + 4;
        cCols.forEach((c) => { doc.text(c.t, x, y, { width: c.w - 6, align: c.a }); x += c.w; });
        y = doc.y + 3;
      };
      hr("#ddd", 0.5); cRowHead(); hr("#eee", 0.5);
      for (const p of d.rows) {
        // A row is: name (may wrap) + numbers + a small type/branches line + divider.
        // Guard generously and re-draw the column header when it spills to a new page.
        if (y + 34 > bottom - 20) { doc.addPage(); y = doc.page.margins.top; cRowHead(); hr("#eee", 0.5); }
        // name + branches-earned-from on a small second line
        doc.font("th").fontSize(9).fillColor("#222");
        let x = left + 4;
        doc.text(p.name, x, y, { width: cCols[0].w - 6 });
        const nameBottom = doc.y;
        x += cCols[0].w;
        doc.fontSize(9).fillColor("#333");
        doc.text(baht(p.preTax), x, y, { width: cCols[1].w - 6, align: "right" }); x += cCols[1].w;
        doc.text(p.wht > 0 ? "−" + baht(p.wht) : "-", x, y, { width: cCols[2].w - 6, align: "right" }); x += cCols[2].w;
        doc.text(p.groupInsurance > 0 ? "−" + baht(p.groupInsurance) : "-", x, y, { width: cCols[3].w - 6, align: "right" }); x += cCols[3].w;
        doc.font("th-b").fillColor("#0f6e56").text(baht(p.net), x, y, { width: cCols[4].w - 6, align: "right" }); x += cCols[4].w;
        doc.font("th").fontSize(7.5).fillColor(p.statusLabel.startsWith("ตัดสิทธิ์") ? "#a32d2d" : "#888")
          .text(p.statusLabel, x, y, { width: cCols[5].w - 6, align: "right" });
        y = Math.max(nameBottom, doc.y);
        doc.font("th").fontSize(7.5).fillColor("#999")
          .text(`${p.typeLabel} · ${p.branchesLabel}`, left + 4, y, { width: cCols[0].w + 40 });
        y = doc.y + 4;
        doc.moveTo(left, y).lineTo(right, y).strokeColor("#f0f0f0").lineWidth(0.5).stroke(); y += 3;
      }
      ensure(20);
      hr("#bbb", 0.8);
      doc.font("th-b").fontSize(9.5).fillColor("#281a0e");
      let tx = left + 4;
      doc.text(`รวม ${d.rows.length} คน`, tx, y, { width: cCols[0].w - 6 }); tx += cCols[0].w;
      doc.text(baht(d.rows.reduce((s, r) => s + r.preTax, 0)), tx, y, { width: cCols[1].w - 6, align: "right" }); tx += cCols[1].w;
      doc.fillColor("#a32d2d").text("−" + baht(d.totals.wht), tx, y, { width: cCols[2].w - 6, align: "right" }); tx += cCols[2].w;
      doc.text(d.totals.groupInsurance > 0 ? "−" + baht(d.totals.groupInsurance) : "-", tx, y, { width: cCols[3].w - 6, align: "right" }); tx += cCols[3].w;
      doc.fillColor("#0f6e56").text(baht(d.totals.netPayout), tx, y, { width: cCols[4].w - 6, align: "right" });
      y = doc.y + 10;

      doc.font("th").fontSize(8).fillColor("#999").text(
        "เอกสารสรุปภายในสำหรับสำนักงานบัญชี · ไม่ใช่เอกสารทางภาษีอย่างเป็นทางการ",
        left, bottom - 12, { width: contentW, align: "center" }
      );
      doc.end();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
