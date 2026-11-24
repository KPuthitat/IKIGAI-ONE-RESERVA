// The formal one-page A4 monthly payslip (for banks / loans / visas) as a PDF (owner 2026-11-24: a laid-out PDF, not
// the browser print dialog). Same data as BankPayslipDocument (buildBankPayslip); pdfkit + LINE Seed Sans TH.

import PDFDocument from "pdfkit";
import path from "node:path";
import { bahtText } from "./bahttext";
import { thaiDate, type BankPayslip } from "./payslip-bank";

const FONT_REG = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Regular.ttf");
const FONT_BOLD = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Bold.ttf");
const INK = "#1f2937", MUTED = "#6b7280", LINE = "#9ca3af", SOFT = "#f3f4f6";
const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function generateBankPayslipPdf(d: BankPayslip): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: `Payslip ${d.docNo}`, Author: "NOKHOOK OS" } });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      doc.registerFont("th", FONT_REG);
      doc.registerFont("th-b", FONT_BOLD);

      const L = doc.page.margins.left, W = doc.page.width - L - doc.page.margins.right, R = L + W;
      const bottom = doc.page.height - doc.page.margins.bottom;
      let y = doc.page.margins.top;
      const { company } = d;

      // ── letterhead ─────────────────────────────────────────
      const rightW = 170;
      doc.font("th-b").fontSize(16).fillColor(INK).text(company?.name_th ?? "IKIGAI MEDIHEALTH", L, y, { width: W - rightW - 10 });
      let ly = doc.y;
      if (company?.address) { doc.font("th").fontSize(8.5).fillColor(MUTED).text(company.address.replace(/\s*\n\s*/g, " "), L, ly, { width: W - rightW - 10 }); ly = doc.y; }
      const ids = [company?.tax_id ? `เลขประจำตัวผู้เสียภาษี ${company.tax_id}` : "", company?.phone ? `โทร ${company.phone}` : ""].filter(Boolean).join("  ·  ");
      if (ids) { doc.font("th").fontSize(8.5).fillColor(MUTED).text(ids, L, ly, { width: W - rightW - 10 }); ly = doc.y; }
      doc.font("th").fontSize(8.5).fillColor(MUTED).text("เลขที่เอกสาร", R - rightW, y + 2, { width: rightW, align: "right" });
      doc.font("th-b").fontSize(10).fillColor(INK).text(d.docNo, R - rightW, y + 13, { width: rightW, align: "right" });
      doc.font("th").fontSize(8.5).fillColor(MUTED).text(`วันที่ออกเอกสาร ${thaiDate(d.issued)}`, R - rightW, y + 28, { width: rightW, align: "right" });
      y = Math.max(ly, y + 42) + 8;
      doc.moveTo(L, y).lineTo(R, y).strokeColor(INK).lineWidth(1.6).stroke(); y += 18;

      // ── title ──────────────────────────────────────────────
      doc.font("th-b").fontSize(18).fillColor(INK).text("ใบแจ้งรายได้ประจำเดือน", L, y, { width: W, align: "center" }); y = doc.y;
      doc.font("th").fontSize(9).fillColor(MUTED).text("PAYSLIP", L, y, { width: W, align: "center" }); y = doc.y + 2;
      doc.font("th").fontSize(11).fillColor(INK).text(`ประจำเดือน ${d.monthText}`, L, y, { width: W, align: "center" }); y = doc.y + 16;

      // ── employee table (4 columns) ─────────────────────────
      const c = [W * 0.2, W * 0.4, W * 0.18, W * 0.22];
      const rows: Array<[string, string, string, string]> = [
        ["ชื่อ-สกุล", d.name, "รหัสพนักงาน", d.employeeCode ?? "—"],
        ["ประเภทการจ้าง", d.empType, "วันที่จ่ายเงิน", d.lastPay ? thaiDate(d.lastPay) : "—"]
      ];
      const RH = 24;
      const cellBox = (x: number, yy: number, w: number, label: boolean) => {
        doc.rect(x, yy, w, RH).fillAndStroke(label ? SOFT : "#ffffff", LINE);
      };
      rows.forEach((r, ri) => {
        let x = L;
        r.forEach((t, i) => {
          cellBox(x, y + ri * RH, c[i], i % 2 === 0);
          doc.font(i === 1 ? "th-b" : "th").fontSize(9.5).fillColor(i % 2 === 0 ? MUTED : INK)
            .text(t, x + 8, y + ri * RH + 6, { width: c[i] - 16, lineBreak: false, height: 14, ellipsis: true });
          x += c[i];
        });
      });
      const by = y + rows.length * RH;
      cellBox(L, by, c[0], true); cellBox(L + c[0], by, W - c[0], false);
      doc.font("th").fontSize(9.5).fillColor(MUTED).text("บัญชีรับเงิน", L + 8, by + 6, { lineBreak: false });
      doc.font("th").fontSize(9.5).fillColor(INK).text(d.bankName && d.bankAccount ? `${d.bankName}  เลขที่ ${d.bankAccount}` : "—", L + c[0] + 8, by + 6, { width: W - c[0] - 16, lineBreak: false, ellipsis: true, height: 14 });
      y = by + RH + 16;

      // ── income / deductions (two tables) ───────────────────
      const gap = 14, tw = (W - gap) / 2, ROW = 24;
      const table = (x: number, title: string, items: Array<[string, number]>, totalLabel: string, total: number, empty: string, totalColor: string) => {
        let ty = y;
        doc.rect(x, ty, tw, ROW).fillAndStroke(SOFT, LINE);
        doc.font("th-b").fontSize(10).fillColor(INK).text(title, x + 8, ty + 6, { width: tw * 0.6, lineBreak: false });
        doc.font("th-b").fontSize(10).fillColor(INK).text("บาท", x + tw * 0.6, ty + 6, { width: tw * 0.4 - 8, align: "right", lineBreak: false });
        ty += ROW;
        if (items.length === 0) {
          doc.rect(x, ty, tw, ROW).fillAndStroke("#ffffff", LINE);
          doc.font("th").fontSize(9.5).fillColor("#9ca3af").text(empty, x + 8, ty + 6, { width: tw - 16, lineBreak: false });
          ty += ROW;
        }
        for (const [label, v] of items) {
          const lh = Math.max(ROW, doc.font("th").fontSize(9.5).heightOfString(label, { width: tw * 0.62 - 16 }) + 12);
          doc.rect(x, ty, tw, lh).fillAndStroke("#ffffff", LINE);
          doc.font("th").fontSize(9.5).fillColor(INK).text(label, x + 8, ty + 6, { width: tw * 0.62 - 16 });
          doc.font("th").fontSize(9.5).fillColor(INK).text(money(v), x + tw * 0.62, ty + 6, { width: tw * 0.38 - 8, align: "right", lineBreak: false });
          ty += lh;
        }
        doc.rect(x, ty, tw, ROW).fillAndStroke(SOFT, LINE);
        doc.font("th-b").fontSize(10).fillColor(INK).text(totalLabel, x + 8, ty + 6, { width: tw * 0.55, lineBreak: false });
        doc.font("th-b").fontSize(10).fillColor(totalColor).text(money(total), x + tw * 0.55, ty + 6, { width: tw * 0.45 - 8, align: "right", lineBreak: false });
        return ty + ROW;
      };
      const e1 = table(L, "รายได้ (Earnings)", d.incomeRows, "รวมรายได้", d.income, "—", INK);
      const e2 = table(L + tw + gap, "รายการหัก (Deductions)", d.dedRows, "รวมรายการหัก", d.ded, "ไม่มีรายการหัก", "#a32d2d");
      y = Math.max(e1, e2) + 18;

      // ── net ────────────────────────────────────────────────
      doc.rect(L, y, W, 58).lineWidth(1.6).strokeColor(INK).stroke();
      doc.font("th-b").fontSize(11.5).fillColor(INK).text("เงินได้สุทธิ (Net Pay)", L + 14, y + 12, { lineBreak: false });
      doc.font("th-b").fontSize(22).fillColor(INK).text(`${money(d.net)}`, L + W * 0.4, y + 6, { width: W * 0.6 - 56, align: "right", lineBreak: false });
      doc.font("th").fontSize(10).fillColor(MUTED).text("บาท", R - 46, y + 15, { width: 34, lineBreak: false });
      doc.font("th").fontSize(9).fillColor(MUTED).text(`(${bahtText(d.net)})`, L + 14, y + 38, { width: W - 28, lineBreak: false, ellipsis: true, height: 12 });
      y += 76;

      // ── statement ──────────────────────────────────────────
      doc.font("th").fontSize(9).fillColor(MUTED).text(
        `บริษัทขอรับรองว่าข้อมูลข้างต้นเป็นความจริง และออกให้เพื่อประกอบการยื่นขอเอกสารต่อหน่วยงานภายนอก${d.allPaid ? "" : " (ข้อมูลระหว่างรอการจ่ายเงินครบทุกรอบ)"}`,
        L, y, { width: W, lineGap: 2 });
      y = doc.y;

      // ── signatures, pinned to the bottom ───────────────────
      const sigTop = Math.max(y + 36, bottom - 190);
      const sw = (W - 50) / 2;
      doc.moveTo(L + 10, sigTop + 60).lineTo(L + sw - 10, sigTop + 60).strokeColor("#6b7280").lineWidth(0.8).stroke();
      doc.font("th").fontSize(9.5).fillColor(INK).text("ผู้มีอำนาจลงนาม / ฝ่ายบุคคล", L, sigTop + 65, { width: sw, align: "center", lineBreak: false });
      doc.font("th").fontSize(9).fillColor(MUTED).text("วันที่ ........ / ........ / ........", L, sigTop + 80, { width: sw, align: "center", lineBreak: false });
      const sx = L + sw + 50;
      doc.rect(sx + 20, sigTop, sw - 40, 70).dash(3, { space: 3 }).strokeColor("#9ca3af").lineWidth(0.8).stroke().undash();
      doc.font("th").fontSize(9.5).fillColor("#9ca3af").text("ตราประทับบริษัท", sx + 20, sigTop + 28, { width: sw - 40, align: "center", lineBreak: false });
      doc.font("th").fontSize(9).fillColor(MUTED).text("(ถ้ามี)", sx, sigTop + 76, { width: sw, align: "center", lineBreak: false });

      // ── footer ─────────────────────────────────────────────
      doc.page.margins.bottom = 0;
      doc.font("th").fontSize(7.5).fillColor("#9ca3af").text(`เอกสารฉบับนี้ออกจากระบบ NOKHOOK OS · เลขที่ ${d.docNo}`, L, doc.page.height - 34, { width: W, align: "center", lineBreak: false });
      doc.end();
    } catch (e) { reject(e); }
  });
}
