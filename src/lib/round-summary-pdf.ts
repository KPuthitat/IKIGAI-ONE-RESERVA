// A4 landscape PDF of the whole-round compensation summary (owner 2026-11-24: "a PDF with a properly laid-out page,
// not the browser print dialog"). pdfkit + LINE Seed Sans TH. Letterhead, period facts, the table with a header that
// repeats on every page, a totals row, the callout and signature boxes kept together, page numbers on every page.

import PDFDocument from "pdfkit";
import path from "node:path";
import { nameWithPrefix } from "./name";
import { branchTaxLabel, maskAccount, STATUS_TH, type RoundSummary } from "./round-summary";

const FONT_REG = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Regular.ttf");
const FONT_BOLD = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Bold.ttf");

const INK = "#281a0e", MUTED = "#6b7280", LINE = "#d9d9d9", HEAD_BG = "#efe6d6", ZEBRA = "#faf7f1", TOTAL_BG = "#f1e8d8", RED = "#a32d2d", GREEN = "#0f6e56", GOLD = "#a06820";

const TH_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const longDate = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return `${dd} ${TH_MONTHS[m - 1]} ${y + 543}`; };
const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cellMoney = (n: number) => (n ? money(n) : "—");

type Col = { label: string; w: number; align: "left" | "right" | "center" };

export function generateRoundSummaryPdf(d: RoundSummary, generatedLabel: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 30, bufferPages: true, info: { Title: "Round compensation summary", Author: "NOKHOOK OS" } });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      doc.registerFont("th", FONT_REG);
      doc.registerFont("th-b", FONT_BOLD);

      const L = doc.page.margins.left;
      const W = doc.page.width - L - doc.page.margins.right;
      const R = L + W;
      const FOOT = 24;                                        // room kept for the page footer
      const bottom = doc.page.height - doc.page.margins.bottom - FOOT;
      let y = doc.page.margins.top;

      // ── columns (sum = W) ───────────────────────────────────
      const fixed: Col[] = [
        { label: "#", w: 20, align: "center" },
        { label: "ชื่อ-สกุล (รหัส)", w: 0, align: "left" },
        { label: "ประเภท", w: 44, align: "center" },
        { label: "วันทำงาน", w: 38, align: "right" },
        { label: "ค่าจ้าง/เงินเดือน", w: 60, align: "right" },
        { label: "OT", w: 50, align: "right" },
        { label: "เซอร์วิส", w: 48, align: "right" },
        { label: "รายได้อื่น", w: 46, align: "right" },
        { label: "รวมรายได้", w: 58, align: "right" },
        { label: "ประกันสังคม", w: 48, align: "right" },
        { label: "ภาษี ณ ที่จ่าย", w: 50, align: "right" },
        { label: "หักอื่นๆ", w: 44, align: "right" },
        { label: "สุทธิ", w: 58, align: "right" },
        { label: "ธนาคาร / บัญชี", w: 106, align: "left" }
      ];
      fixed[1].w = W - fixed.reduce((s, c) => s + c.w, 0);
      const cols = fixed;
      const colX = (i: number) => L + cols.slice(0, i).reduce((s, c) => s + c.w, 0);

      const text = (t: string, x: number, yy: number, w: number, align: "left" | "right" | "center", o: { font?: "th" | "th-b"; size?: number; color?: string } = {}) => {
        doc.font(o.font ?? "th").fontSize(o.size ?? 8.5).fillColor(o.color ?? "#222");
        doc.text(t, x + 3, yy, { width: w - 6, align, lineBreak: false, height: (o.size ?? 8.5) * 1.5, ellipsis: true });
      };

      // ── letterhead ──────────────────────────────────────────
      const { company, branch, period } = d;
      doc.font("th-b").fontSize(15).fillColor(INK).text(company?.name_th ?? "IKIGAI MEDIHEALTH", L, y, { width: W, align: "center" }); y = doc.y;
      if (company?.name_en) { doc.font("th").fontSize(8.5).fillColor(MUTED).text(company.name_en, L, y, { width: W, align: "center" }); y = doc.y; }
      if (branch) { doc.font("th-b").fontSize(9.5).fillColor("#333").text(`${branch.name} · ${branchTaxLabel(branch.tax_branch_code)}`, L, y + 1, { width: W, align: "center" }); y = doc.y; }
      if (d.addressToShow) { doc.font("th").fontSize(8).fillColor(MUTED).text(d.addressToShow.replace(/\s*\n\s*/g, " "), L, y, { width: W, align: "center" }); y = doc.y; }
      const ids = [company?.tax_id ? `เลขประจำตัวผู้เสียภาษี ${company.tax_id}` : "", company?.phone ? `โทร ${company.phone}` : ""].filter(Boolean).join(" · ");
      if (ids) { doc.font("th").fontSize(8).fillColor(MUTED).text(ids, L, y, { width: W, align: "center" }); y = doc.y; }
      y += 4;
      doc.moveTo(L, y).lineTo(R, y).strokeColor(GOLD).lineWidth(1.2).stroke(); y += 6;
      doc.font("th-b").fontSize(12.5).fillColor(INK).text("สรุปค่าตอบแทนทั้งรอบ (สำหรับสำนักงานบัญชี)", L, y, { width: W, align: "center" }); y = doc.y;
      if (d.companyCount > 1 || d.branchCount > 1) {
        doc.font("th").fontSize(7.5).fillColor("#b45309").text(`* รอบนี้มีพนักงานหลาย${d.companyCount > 1 ? "บริษัท" : "สาขา"} — หัวกระดาษแสดงข้อมูลของ${d.companyCount > 1 ? "บริษัท" : "สาขา"}ที่มีพนักงานมากที่สุด`, L, y, { width: W, align: "center" }); y = doc.y;
      }
      y += 5;

      // ── period facts (a light box) ──────────────────────────
      const facts: Array<[string, string]> = [
        ["รอบ", `${longDate(period.period_start)} – ${longDate(period.period_end)}`],
        ["วันจ่าย", longDate(period.pay_date)],
        ["ประเภทรอบ", period.cycle === "weekly" ? "รายสัปดาห์" : "รายเดือน"],
        ["สถานะ", STATUS_TH[period.status]],
        ["จำนวนพนักงาน", `${d.lines.length} คน`]
      ];
      doc.roundedRect(L, y, W, 22, 4).fillColor("#faf7f1").fill();
      let fx = L + 10;
      for (const [k, v] of facts) {
        doc.font("th").fontSize(8).fillColor(MUTED); const kw = doc.widthOfString(`${k}: `);
        doc.text(`${k}: `, fx, y + 6.5, { lineBreak: false });
        doc.font("th-b").fontSize(8.5).fillColor(INK); const vw = doc.widthOfString(v);
        doc.text(v, fx + kw, y + 6, { lineBreak: false });
        fx += kw + vw + 22;
      }
      y += 30;

      // ── table ───────────────────────────────────────────────
      const HEAD_H = 24, ROW_H = 17;
      const drawHead = () => {
        doc.rect(L, y, W, HEAD_H).fillColor(HEAD_BG).fill();
        cols.forEach((c, i) => {
          doc.font("th-b").fontSize(7.8).fillColor(INK);
          const hh = doc.heightOfString(c.label, { width: c.w - 6 });
          doc.text(c.label, colX(i) + 3, y + Math.max(2, (HEAD_H - hh) / 2), { width: c.w - 6, align: c.align });
        });
        y += HEAD_H;
      };
      const newPage = () => { doc.addPage(); y = doc.page.margins.top; drawHead(); };

      if (d.lines.length === 0) {
        doc.font("th").fontSize(10).fillColor(MUTED).text("ยังไม่มีพนักงานในรอบนี้", L, y + 20, { width: W, align: "center" }); y = doc.y + 20;
      } else {
        drawHead();
        d.lines.forEach((l, i) => {
          if (y + ROW_H > bottom) newPage();
          if (i % 2 === 1) doc.rect(L, y, W, ROW_H).fillColor(ZEBRA).fill();
          const ty = y + 4.5;
          const nm = `${nameWithPrefix(l.title_prefix, l.display_name)}${l.employee_code ? ` (${l.employee_code})` : ""}`;
          text(String(i + 1), colX(0), ty, cols[0].w, "center", { color: MUTED });
          text(nm, colX(1), ty, cols[1].w, "left");
          text(l.employment_type === "ft" ? "ประจำ" : l.employment_type === "pt" ? "พาร์ทไทม์" : "—", colX(2), ty, cols[2].w, "center", { color: MUTED, size: 8 });
          text(String(l.days_worked), colX(3), ty, cols[3].w, "right");
          text(cellMoney(l.base_pay), colX(4), ty, cols[4].w, "right");
          text(cellMoney(l.ot_pay), colX(5), ty, cols[5].w, "right");
          text(cellMoney(l.service_charge), colX(6), ty, cols[6].w, "right");
          text(cellMoney(l.other_additions), colX(7), ty, cols[7].w, "right");
          text(cellMoney(l.gross_pay), colX(8), ty, cols[8].w, "right", { font: "th-b" });
          text(cellMoney(l.sso_amount), colX(9), ty, cols[9].w, "right", { color: l.sso_amount ? RED : "#999" });
          text(cellMoney(l.tax_amount), colX(10), ty, cols[10].w, "right", { color: l.tax_amount ? RED : "#999" });
          text(cellMoney(l.other_deductions), colX(11), ty, cols[11].w, "right", { color: l.other_deductions ? RED : "#999" });
          text(cellMoney(l.net_pay), colX(12), ty, cols[12].w, "right", { font: "th-b", color: GREEN });
          text(l.bank_name ? `${l.bank_name} ${maskAccount(l.bank_account)}` : "—", colX(13), ty, cols[13].w, "left", { color: MUTED, size: 7.5 });
          y += ROW_H;
          doc.moveTo(L, y).lineTo(R, y).strokeColor("#ececec").lineWidth(0.4).stroke();
        });
        // totals row (kept with the last rows: if it would not fit, the header and the last row move to a new page together is not needed — only the totals)
        if (y + ROW_H + 4 > bottom) newPage();
        doc.rect(L, y, W, ROW_H + 2).fillColor(TOTAL_BG).fill();
        doc.moveTo(L, y).lineTo(R, y).strokeColor("#8a7a5a").lineWidth(1).stroke();
        const ty = y + 5;
        text(`รวมทั้งสิ้น (${d.lines.length} คน)`, colX(1), ty, cols[1].w, "left", { font: "th-b" });
        const t = d.tot;
        [[4, t.base], [5, t.ot], [6, t.svc], [7, t.add], [8, t.gross], [9, t.sso], [10, t.tax], [11, t.ded], [12, t.net]].forEach(([ci, v]) =>
          text(cellMoney(v as number), colX(ci as number), ty, cols[ci as number].w, "right", { font: "th-b", color: ci === 12 ? GREEN : ci >= 9 ? RED : INK }));
        y += ROW_H + 2;
      }

      // ── callout + signatures, kept together on one page ──────
      const BLOCK_H = 84;
      if (y + 12 + BLOCK_H > bottom) { doc.addPage(); y = doc.page.margins.top; }
      y += 14;
      const t = d.tot;
      doc.font("th").fontSize(9).fillColor("#444");
      doc.text(`รวมรายได้ (Gross):  ฿${money(t.gross)}`, L, y, { lineBreak: false });
      doc.text(`รวมรายการหัก:  ฿${money(d.totalDeductions)}  (ประกันสังคม ฿${money(t.sso)} · ภาษี ฿${money(t.tax)} · อื่นๆ ฿${money(t.ded + t.welfare)})`, L, y + 14, { lineBreak: false });
      doc.font("th-b").fontSize(12).fillColor(GREEN).text(`ยอดจ่ายสุทธิทั้งรอบ:  ฿${money(t.net)}`, L, y + 32, { lineBreak: false });
      // signature lines on the right
      const sigW = 150;
      [["ผู้จัดทำ", R - sigW * 2 - 40], ["ผู้อนุมัติ", R - sigW]].forEach(([label, x]) => {
        doc.moveTo(x as number, y + 40).lineTo((x as number) + sigW, y + 40).strokeColor("#777").lineWidth(0.7).stroke();
        doc.font("th").fontSize(8.5).fillColor(MUTED).text(`${label}`, x as number, y + 44, { width: sigW, align: "center", lineBreak: false });
        doc.text("วันที่ ____/____/________", x as number, y + 58, { width: sigW, align: "center", lineBreak: false });
      });

      // ── footer on every page ────────────────────────────────
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const savedBottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;                           // write inside the bottom margin without starting a new page
        const fy = doc.page.height - 30;
        doc.moveTo(L, fy - 4).lineTo(R, fy - 4).strokeColor(LINE).lineWidth(0.5).stroke();
        doc.font("th").fontSize(7).fillColor("#9ca3af")
          .text("เอกสารสรุปภายในเพื่อการจัดทำบัญชี — เลขบัญชีธนาคารถูกปิดบางส่วนเพื่อความปลอดภัย", L, fy, { width: W * 0.65, align: "left", lineBreak: false });
        doc.text(`พิมพ์เมื่อ ${generatedLabel}  ·  หน้า ${i - range.start + 1} / ${range.count}`, L + W * 0.55, fy, { width: W * 0.45, align: "right", lineBreak: false });
        doc.page.margins.bottom = savedBottom;
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}
