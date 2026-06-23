// Revenue-Share GP statement PDF (owner 2026-06-22). A4, server-side via pdfkit
// + the embedded LINE Seed Sans TH TTF (same setup as inventa-po-pdf.ts) so Thai
// shapes correctly. pdfkit is marked external in next.config.js.

import PDFDocument from "pdfkit";
import path from "node:path";

export type StatementPdfData = {
  seller: { name: string; address: string | null; taxBranchCode: string | null; phone: string | null; taxId: string | null };
  partner: { name: string; venue: string | null };
  buyer: { taxId: string | null; address: string | null; branchCode: string | null };
  monthLabel: string;        // "มิถุนายน 2569"
  invoiceNo: string | null;
  status: string;            // localised Thai status
  withVat: boolean;
  result: {
    totalSales: number; tierGP: number; floorApplied: number; topup: number; billedGP: number;
    avgGpPct: number; vatAmount: number; whtAmount: number; netAmount: number;
  };
  breakdown: Array<{ label: string; sales: number; roundGP: number }>;
};

const FONT_REG = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Regular.ttf");
const FONT_BOLD = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Bold.ttf");
const baht = (n: number) => "฿" + n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function generateStatementPdf(d: StatementPdfData): Promise<Buffer> {
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
      const contentW = right - left;
      const r = d.result;

      // Header
      doc.font("th-b").fontSize(20).fillColor("#281a0e").text("ใบสรุปส่วนแบ่งยอดขาย (GP)", left, doc.page.margins.top);
      doc.font("th").fontSize(10).fillColor("#a06820").text(`รอบเดือน ${d.monthLabel}`, left, doc.y + 2);
      if (d.invoiceNo) doc.fillColor("#666").text(`เลขที่ ${d.invoiceNo}`);
      doc.fillColor("#666").text(`สถานะ: ${d.status}`);

      // Seller (right)
      const top = doc.page.margins.top;
      doc.font("th-b").fontSize(11).fillColor("#281a0e").text(d.seller.name, left + contentW / 2, top, { width: contentW / 2, align: "right" });
      doc.font("th").fontSize(9).fillColor("#555");
      if (d.seller.address) doc.text(d.seller.address, left + contentW / 2, doc.y + 1, { width: contentW / 2, align: "right" });
      if (d.seller.taxId) doc.text(`เลขผู้เสียภาษี ${d.seller.taxId}${d.seller.taxBranchCode ? ` (สาขา ${d.seller.taxBranchCode})` : ""}`, { width: contentW / 2, align: "right" });
      else if (d.seller.taxBranchCode) doc.text(`รหัสสาขา ${d.seller.taxBranchCode}`, { width: contentW / 2, align: "right" });
      if (d.seller.phone) doc.text(`โทร. ${d.seller.phone}`, { width: contentW / 2, align: "right" });

      // Buyer (partner) block — for the tax invoice.
      let y = Math.max(doc.y, top + 64) + 12;
      doc.font("th").fontSize(10).fillColor("#666").text("ลูกค้า/ผู้ซื้อ:", left, y, { continued: true });
      doc.font("th-b").fillColor("#281a0e").text(` ${d.partner.name}${d.partner.venue ? ` (${d.partner.venue})` : ""}`);
      doc.font("th").fontSize(9).fillColor("#555");
      if (d.buyer.address) doc.text(d.buyer.address, left, doc.y + 1, { width: contentW * 0.7 });
      if (d.buyer.taxId) doc.text(`เลขประจำตัวผู้เสียภาษี ${d.buyer.taxId}${d.buyer.branchCode ? ` (สาขา ${d.buyer.branchCode})` : ""}`, left, doc.y + 1, { width: contentW * 0.7 });
      y = doc.y + 12;

      // Round breakdown table
      doc.moveTo(left, y).lineTo(right, y).strokeColor("#bbb").lineWidth(0.8).stroke(); y += 6;
      doc.font("th-b").fontSize(9).fillColor("#281a0e");
      doc.text("รอบ", left + 3, y); doc.text("ยอดขาย", right - 230, y, { width: 110, align: "right" }); doc.text("GP", right - 110, y, { width: 110, align: "right" });
      y += 16; doc.moveTo(left, y).lineTo(right, y).strokeColor("#ddd").lineWidth(0.5).stroke(); y += 4;
      doc.font("th").fontSize(9).fillColor("#333");
      for (const b of d.breakdown) {
        doc.text(b.label, left + 3, y, { width: contentW - 240 });
        doc.text(baht(b.sales), right - 230, y, { width: 110, align: "right" });
        doc.text(baht(b.roundGP), right - 110, y, { width: 110, align: "right" });
        y = doc.y + 4;
      }
      doc.moveTo(left, y).lineTo(right, y).strokeColor("#bbb").lineWidth(0.8).stroke(); y += 8;

      // Summary lines
      const line = (label: string, value: string, bold = false, color = "#281a0e") => {
        doc.font(bold ? "th-b" : "th").fontSize(bold ? 12 : 10).fillColor(color);
        doc.text(label, left, y, { width: contentW - 150 });
        doc.text(value, right - 150, y, { width: 150, align: "right" });
        y = doc.y + (bold ? 6 : 4);
      };
      line("ยอดขายรวมทั้งเดือน", baht(r.totalSales));
      line(`GP เรียกเก็บ (เฉลี่ย ${(r.avgGpPct * 100).toFixed(2)}%)`, baht(r.billedGP));
      if (r.topup > 0) line(`  • ถึงยอดขั้นต่ำ ฿${r.floorApplied.toLocaleString("th-TH")} (ส่วนต่าง ${baht(r.topup)})`, "", false, "#854f0b");
      if (d.withVat) { line("VAT 7%", baht(r.vatAmount)); line("รวมตามใบกำกับภาษี", baht(r.billedGP + r.vatAmount), true); }
      line("หัก ณ ที่จ่าย 3%", "−" + baht(r.whtAmount), false, "#a32d2d");
      y += 4; doc.moveTo(left, y).lineTo(right, y).strokeColor("#bbb").lineWidth(0.8).stroke(); y += 8;
      line("รับสุทธิ", baht(r.netAmount), true, "#0f6e56");

      doc.font("th").fontSize(8).fillColor("#999").text(
        "เอกสารนี้ใช้ติดตามภายใน ไม่ใช่เอกสารทางภาษีอย่างเป็นทางการ", left, doc.page.height - doc.page.margins.bottom - 14, { width: contentW, align: "center" }
      );
      doc.end();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
