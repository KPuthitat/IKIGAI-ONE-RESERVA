// A4 PDF of the combined monthly payslip (all pay rounds of a calendar month + the SVC payout), owner 2026-11-24.
// Same data as the page (buildMonthlyPayslip), so the figures are identical. Admin audience only (the page is admin-side).

import PDFDocument from "pdfkit";
import path from "node:path";
import { t } from "./i18n";
import { nameWithPrefix } from "./name";
import type { MonthlyPayslip } from "./monthly-payslip";

const FONT_REG = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Regular.ttf");
const FONT_BOLD = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Bold.ttf");
const INK = "#1f2937", MUTED = "#6b7280", LINE = "#d1d5db", SOFT = "#f3f4f6", GREEN = "#0f6e56", RED = "#a32d2d", VIOLET = "#6d28d9";
const TH_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const longDate = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return `${dd} ${TH_MONTHS[m - 1]} ${y + 543}`; };
const shortDate = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return `${dd} ${TH_MONTHS[m - 1].slice(0, 3)}${m === 5 ? "" : "."} ${String(y + 543).slice(2)}`; };
const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const maskAccount = (acc: string | null) => { if (!acc) return "—"; const d = acc.replace(/\D/g, ""); return d.length < 8 ? acc : `${d.slice(0, 3)}-x-xxxxx-${d.slice(-1)}`; };
function fmtMinShort(min: number): string {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  if (h === 0 && m === 0) return "—";
  return `${h ? `${h} ชม.` : ""}${h && m ? " " : ""}${m ? `${m} น.` : ""}`;
}

export function generateMonthlyPayslipPdf(d: MonthlyPayslip, month: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const [my, mm] = month.split("-").map(Number);
      const monthText = `${TH_MONTHS[mm - 1]} พ.ศ. ${my + 543}`;
      const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: true, info: { Title: "Monthly payslip", Author: "NOKHOOK OS" } });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      doc.registerFont("th", FONT_REG);
      doc.registerFont("th-b", FONT_BOLD);

      const L = doc.page.margins.left, W = doc.page.width - L - doc.page.margins.right, R = L + W;
      const bottom = doc.page.height - doc.page.margins.bottom - 20;
      let y = doc.page.margins.top;
      const ensure = (need: number) => { if (y + need > bottom) { doc.addPage(); y = doc.page.margins.top; } };
      const tx = (s: string, x: number, yy: number, w: number, o: { font?: "th" | "th-b"; size?: number; color?: string; align?: "left" | "right" | "center" } = {}) => {
        doc.font(o.font ?? "th").fontSize(o.size ?? 9.5).fillColor(o.color ?? INK).text(s, x, yy, { width: w, align: o.align ?? "left", lineBreak: false, ellipsis: true, height: (o.size ?? 9.5) * 1.5 });
      };
      const section = (title: string) => { ensure(40); tx(title, L, y, W, { font: "th-b", size: 11 }); y += 17; doc.moveTo(L, y).lineTo(R, y).strokeColor(LINE).lineWidth(0.6).stroke(); y += 6; };
      const kv = (label: string, value: string, o: { bold?: boolean; color?: string; note?: string } = {}) => {
        ensure(o.note ? 28 : 16);
        tx(label, L + 4, y, W * 0.62, { color: MUTED });
        tx(value, L + W * 0.55, y, W * 0.45 - 4, { align: "right", font: o.bold ? "th-b" : "th", color: o.color });
        y += 15;
        if (o.note) { doc.font("th").fontSize(8).fillColor("#9ca3af").text(o.note, L + 4, y - 2, { width: W - 8 }); y = doc.y + 3; }
      };

      // ── header ──
      tx("IKIGAI MEDIHEALTH", L, y, W, { font: "th-b", size: 17, align: "center" }); y += 22;
      if (d.company?.name_th) { tx(d.company.name_th, L, y, W, { align: "center", color: MUTED }); y += 14; }
      if (d.headerAddress) { doc.font("th").fontSize(8.5).fillColor(MUTED).text(d.headerAddress, L, y, { width: W, align: "center" }); y = doc.y + 2; }
      const sub = [d.company?.tax_id ? `เลขประจำตัวผู้เสียภาษี ${d.company.tax_id}` : "", d.mainBranch?.name ? `สาขา ${d.mainBranch.name}` : ""].filter(Boolean).join("  ·  ");
      if (sub) { tx(sub, L, y, W, { align: "center", size: 8.5, color: MUTED }); y += 13; }
      doc.moveTo(L, y + 2).lineTo(R, y + 2).strokeColor("#9ca3af").lineWidth(1.2).stroke(); y += 10;
      tx(`สลิปค่าตอบแทนรายเดือน · ${monthText}`, L, y, W, { font: "th-b", size: 13, align: "center" }); y += 24;

      // ── employee ──
      const half = W / 2;
      const info: Array<[string, string]> = [
        [t("th", "admin.persona.payroll.payslip.employeeName"), nameWithPrefix(d.profile.title_prefix, d.profile.display_name)],
        [t("th", "admin.persona.payroll.payslip.employeeCode"), d.profile.employee_code ?? "—"],
        [t("th", "admin.persona.payroll.payslip.employmentType"), d.employmentLabel],
        ["รอบเดือน", monthText]
      ];
      info.forEach(([k, v], i) => { const x = L + (i % 2) * half; tx(`${k}:`, x, y, 80, { color: MUTED }); tx(v, x + 82, y, half - 90, { font: "th-b" }); if (i % 2 === 1) y += 15; });
      if (info.length % 2) y += 15;
      if (d.empType === "ft" && d.salarySnap != null) { tx(`อัตราค่าตอบแทน: เงินเดือน ฿${money(d.salarySnap)} ÷ 30 วัน = ฿${money(d.salarySnap / 30)}/วัน ÷ 8 ชม. = ฿${money(d.salarySnap / 30 / 8)}/ชม.`, L, y, W, { size: 8.5, color: MUTED }); y += 14; }
      if (d.empType === "pt" && d.hourlySnap != null) { tx(`อัตราค่าตอบแทน: ฿${money(d.hourlySnap)}/ชม. × ชั่วโมงทำงานจริง (หลังหักเวลาพัก)`, L, y, W, { size: 8.5, color: MUTED }); y += 14; }
      y += 4;

      // ── per-round table ──
      if (d.rows.length > 0) {
        section(d.isWeekly ? "รายละเอียดรายสัปดาห์" : "รายละเอียดรอบจ่าย");
        const widths = [150, 90, 80, 100, 0]; widths[4] = W - widths.slice(0, 4).reduce((s, w) => s + w, 0);
        const xs = widths.map((_, i) => L + widths.slice(0, i).reduce((s, w) => s + w, 0));
        const heads = ["วันที่", "ค่าตอบแทน", "รายได้อื่นๆ", "รายการหัก", "สุทธิ"];
        const head = () => { doc.rect(L, y, W, 18).fillColor(SOFT).fill(); heads.forEach((h, i) => tx(h, xs[i] + 3, y + 4, widths[i] - 6, { font: "th-b", size: 8.5, align: i === 0 ? "left" : "right" })); y += 18; };
        head();
        for (const w of d.rows) {
          const comp = w.base_pay + w.ot_pay, other = Math.round((w.gross_pay - comp) * 100) / 100;
          const ded = w.sso_amount + w.tax_amount + w.other_deductions + w.drink_deductions + w.mealpass_deductions + w.special_paid_out;
          const subs: string[] = [];
          if (w.ot_pay > 0) subs.push(`รวมโอที ฿${money(w.ot_pay)}`);
          if (w.unpaid_leave_days > 0 && w.unpaid_leave_deduction > 0) subs.push(`หักลาไม่รับค่าจ้าง ${w.unpaid_leave_days} วัน −฿${money(w.unpaid_leave_deduction)}`);
          if (w.service_charge > 0) subs.push(`เซอร์วิสชาร์จในรอบ ฿${money(w.service_charge)}`);
          const rh = subs.length ? 37 : 25;
          if (y + rh > bottom) { doc.addPage(); y = doc.page.margins.top; head(); }
          tx(`${shortDate(w.period_start)} – ${shortDate(w.period_end)}`, xs[0] + 3, y + 3, widths[0] - 6, { size: 8.5 });
          tx(`จ่าย ${shortDate(w.pay_date)}${w.days_worked > 0 ? ` · ${w.days_worked} วัน` : ""}`, xs[0] + 3, y + 13, widths[0] - 6, { size: 7.5, color: MUTED });
          tx(comp ? money(comp) : "—", xs[1] + 3, y + 3, widths[1] - 6, { size: 8.5, align: "right" });
          tx(other ? money(other) : "—", xs[2] + 3, y + 3, widths[2] - 6, { size: 8.5, align: "right" });
          tx(ded ? money(ded) : "—", xs[3] + 3, y + 3, widths[3] - 6, { size: 8.5, align: "right", color: RED });
          tx(money(w.net_pay), xs[4] + 3, y + 3, widths[4] - 6, { font: "th-b", size: 8.5, align: "right" });
          if (subs.length) tx(subs.join(" · "), xs[0] + 3, y + 24, W - 6, { size: 7.5, color: MUTED });
          y += subs.length ? 37 : 25;
          doc.moveTo(L, y).lineTo(R, y).strokeColor("#e5e7eb").lineWidth(0.5).stroke();
        }
        ensure(22);
        doc.moveTo(L, y + 1).lineTo(R, y + 1).strokeColor("#6b7280").lineWidth(1).stroke();
        tx("รวมทั้งเดือน", xs[0] + 3, y + 6, widths[0] - 6, { font: "th-b", size: 8.5 });
        tx(money(d.tot.comp), xs[1] + 3, y + 6, widths[1] - 6, { font: "th-b", size: 8.5, align: "right" });
        tx(money(d.tot.other), xs[2] + 3, y + 6, widths[2] - 6, { font: "th-b", size: 8.5, align: "right" });
        tx(money(d.tot.ded), xs[3] + 3, y + 6, widths[3] - 6, { font: "th-b", size: 8.5, align: "right", color: RED });
        tx(money(d.tot.net), xs[4] + 3, y + 6, widths[4] - 6, { font: "th-b", size: 8.5, align: "right", color: GREEN });
        y += 28;
      }

      // ── income ──
      section("รายได้");
      for (const [bid, v] of d.branchIncomeLines) {
        kv(`รับจาก ${bid != null ? (d.branchNameById.get(bid) ?? `สาขา #${bid}`) : "ค่าจ้าง (ไม่ระบุสาขา)"}`, money(v.income), { note: v.ot > 0 ? `รวมโอที ฿${money(v.ot)}` : undefined });
      }
      if (d.unpaidDays > 0 && d.unpaidCut > 0) {
        const eq = d.salarySnap != null && Math.round(d.salarySnap / 30 * d.unpaidDays * 100) / 100 === d.unpaidCut ? ` (= เงินเดือน ฿${money(d.salarySnap)} ÷ 30 × ${d.unpaidDays})` : "";
        kv("", "", { note: `ค่าตอบแทนข้างต้นหักวันลาไม่รับค่าจ้าง/ขาดงาน ${d.unpaidDays} วันแล้ว −฿${money(d.unpaidCut)}${eq}` });
      }
      if (d.svcIncome > 0) {
        kv(`เซอร์วิสชาร์จ${d.meetingFeeGross > 0 ? " + เบี้ยประชุม" : ""}${d.dutyFeeGross > 0 ? " + ตำแหน่งงานค่าตอบแทนพิเศษ" : ""}`, money(d.svcIncome), {
          color: VIOLET, note: `${d.svcWht > 0 ? "ถูกหักภาษี ณ ที่จ่าย" : "ไม่ถูกหักภาษี ณ ที่จ่าย"} · ${d.svcPayLabel}${d.meetingPayLabel ? ` · ${d.meetingPayLabel}` : ""}`
        });
      }
      doc.moveTo(L, y).lineTo(R, y).strokeColor(LINE).lineWidth(0.6).stroke(); y += 4;
      kv("รวมรายได้ทั้งหมด", money(d.incomeTotal), { bold: true });

      // ── deductions ──
      y += 6; section("รายการหัก");
      if (d.dedBreak.sso > 0) kv(t("th", "admin.persona.payroll.col.sso"), money(d.dedBreak.sso));
      if (d.whtTotal > 0) kv(t("th", "admin.persona.payroll.col.tax"), money(d.whtTotal), { note: d.svcWht > 0 ? "(รวมที่หักจากเซอร์วิสชาร์จ)" : undefined });
      if (d.dedBreak.drink > 0) kv(t("th", "admin.persona.payroll.col.drinkDed"), money(d.dedBreak.drink));
      if (d.dedBreak.mealpass > 0) kv(t("th", "admin.persona.payroll.col.mealpassDed"), money(d.dedBreak.mealpass));
      if (d.dedBreak.other > 0) kv(t("th", "admin.persona.payroll.col.otherDed"), money(d.dedBreak.other));
      if (d.svcGroupInsurance > 0) kv("ประกันกลุ่ม", money(d.svcGroupInsurance), { note: "(หักจากเซอร์วิสชาร์จ)" });
      if (d.dedTotal === 0) kv(t("th", "admin.persona.payroll.payslip.noDeductions"), "—");
      doc.moveTo(L, y).lineTo(R, y).strokeColor(LINE).lineWidth(0.6).stroke(); y += 4;
      kv("รวมรายการหัก", money(d.dedTotal), { bold: true, color: RED });

      // ── net box ──
      y += 8; ensure(d.profile.bank_name ? 92 : 78);
      const bh = d.profile.bank_name && d.profile.bank_account ? 84 : 66;
      doc.rect(L, y, W, bh).fillColor(SOFT).fill(); doc.rect(L, y, W, bh).strokeColor(INK).lineWidth(1.2).stroke();
      tx("รายได้ก่อนหัก (รวมรายรับทั้งหมด)", L + 10, y + 8, W * 0.55, { font: "th-b" });
      tx(`${money(d.incomeTotal)} บาท`, L + W * 0.5, y + 8, W * 0.5 - 10, { font: "th-b", align: "right" });
      tx("รวมรายการหัก", L + 10, y + 24, W * 0.55, { color: MUTED });
      tx(`− ${money(d.dedTotal)} บาท`, L + W * 0.5, y + 24, W * 0.5 - 10, { align: "right", color: RED });
      doc.moveTo(L + 10, y + 41).lineTo(R - 10, y + 41).strokeColor(LINE).lineWidth(0.8).stroke();
      tx("รายได้สุทธิ (รับจริง)", L + 10, y + 47, W * 0.45, { font: "th-b", size: 12 });
      tx(`${money(d.netTotal)} บาท`, L + W * 0.4, y + 45, W * 0.6 - 10, { font: "th-b", size: 15, align: "right", color: GREEN });
      if (d.profile.bank_name && d.profile.bank_account) tx(`${t("th", "admin.persona.payroll.payslip.transferTo")}: ${d.profile.bank_name} ${maskAccount(d.profile.bank_account)}`, L + 10, y + 68, W - 20, { size: 8.5, color: MUTED });
      y += bh + 14;

      // ── daily calculation per round ──
      if (d.dayLogs.length > 0) {
        ensure(60);
        section("รายละเอียดการคำนวณรายวัน");
        for (const { w, days, ftMonthly } of d.dayLogs) {
          const showPay = !ftMonthly;
          const widths = showPay ? [40, 74, 62, 90, 68, 0] : [40, 80, 70, 110, 0];
          widths[widths.length - 1] = W - widths.slice(0, -1).reduce((s, x) => s + x, 0);
          const heads = showPay ? ["วันที่", "เวลาเข้า–ออก", "ชั่วโมงทำงาน", "ค่าล่วงเวลา", "ค่าตอบแทน", "หมายเหตุ"] : ["วันที่", "เวลาเข้า–ออก", "ชั่วโมงทำงาน", "ค่าล่วงเวลา", "หมายเหตุ"];
          const xs = widths.map((_, i) => L + widths.slice(0, i).reduce((s, x) => s + x, 0));
          ensure(60);
          tx(`งวด ${longDate(w.period_start)} – ${longDate(w.period_end)} · จ่าย ${longDate(w.pay_date)}`, L, y, W, { font: "th-b", size: 9 }); y += 14;
          const head = () => { doc.rect(L, y, W, 18).fillColor(SOFT).fill(); heads.forEach((h, i) => tx(h, xs[i] + 3, y + 4, widths[i] - 6, { font: "th-b", size: 8, align: i >= 2 && i < heads.length - 1 ? "right" : "left" })); y += 18; };
          head();
          let sumPay = 0;
          days.forEach((dd, i) => {
            sumPay += dd.pay;
            const worked = dd.pairs.filter((p) => p.workIn || p.workOut);
            const f = worked[0], l = worked[worked.length - 1];
            const clock = f ? `${f.workIn ?? "—"}–${l?.workOut ?? "—"}` : (() => {
              const sp = dd.pairs.find((p) => p.statusLabel === "ตามตารางกะ" && p.schedIn && p.schedOut);
              return sp ? `${sp.schedIn}–${sp.schedOut}` : (dd.pairs.find((p) => p.statusLabel)?.statusLabel ?? "—");
            })();
            const isDouble = dd.pairs.some((p) => p.double), isSpecial = dd.pairs.some((p) => p.holiday), isRest = dd.pairs.some((p) => p.restDay);
            const status = dd.pairs.find((p) => p.statusLabel)?.statusLabel ?? null;
            const otAmt = Math.round((dd.otPay + (isDouble || isRest ? dd.premiumPay : 0)) * 100) / 100;
            const notes: string[] = [];
            if (isDouble) notes.push(`จ่ายสองเท่า${dd.premiumPay > 0 ? ` (เบี้ย ฿${money(dd.premiumPay)})` : ""}`);
            if (isRest && !isDouble) notes.push(`ทำงานวันหยุด${dd.premiumPay > 0 ? ` (+฿${money(dd.premiumPay)})` : ""}`);
            if (isSpecial && !isDouble) notes.push(`วันพิเศษ${dd.premiumPay > 0 ? ` +฿${money(dd.premiumPay)}` : ""}`);
            if (dd.absenceDeduction > 0) notes.push(`หักวันขาดงาน −฿${money(dd.absenceDeduction)}`);
            if (worked.length > 0 && status) notes.push(status);
            if (worked.length > 0 && dd.pairs[0]?.branch) notes.push(dd.pairs[0].branch);
            if (dd.edited) notes.push("แก้ไข");
            const rh = 17;
            if (y + rh > bottom) { doc.addPage(); y = doc.page.margins.top; head(); }
            if (i % 2 === 1) doc.rect(L, y, W, rh).fillColor("#fafafa").fill();
            const cells = [dd.date.slice(5), clock, dd.effectiveMinutes > 0 ? fmtMinShort(dd.effectiveMinutes) : "—",
              dd.otMinutes === 0 && otAmt === 0 ? "—" : `${dd.otMinutes > 0 ? fmtMinShort(dd.otMinutes) : ""}${otAmt > 0 ? `${dd.otMinutes > 0 ? " " : ""}฿${money(otAmt)}` : ""}`];
            if (showPay) cells.push(dd.pay > 0 ? money(dd.pay) : "—");
            cells.push(notes.join(" · "));
            cells.forEach((c, k) => tx(c, xs[k] + 3, y + 4, widths[k] - 6, { size: 8, align: k >= 2 && k < cells.length - 1 ? "right" : "left", color: k === cells.length - 1 ? MUTED : INK }));
            y += rh;
          });
          if (showPay && sumPay > 0) {
            ensure(20);
            doc.moveTo(L, y).lineTo(R, y).strokeColor("#9ca3af").lineWidth(0.8).stroke();
            tx("รวมค่าตอบแทนในงวด", L + 3, y + 4, widths[0] + widths[1] + widths[2] + widths[3] - 6, { font: "th-b", size: 8.5 });
            tx(money(sumPay), xs[4] + 3, y + 4, widths[4] - 6, { font: "th-b", size: 8.5, align: "right" });
            y += 20;
          }
          y += 8;
        }
      }

      // ── signatures ──
      y += 10; ensure(70);
      const sw = (W - 40) / 2;
      doc.moveTo(L + 8, y + 36).lineTo(L + sw - 8, y + 36).strokeColor("#6b7280").lineWidth(0.8).stroke();
      doc.moveTo(L + sw + 40 + 8, y + 36).lineTo(R - 8, y + 36).stroke();
      tx(t("th", "admin.persona.payroll.payslip.employeeSignature"), L, y + 41, sw, { align: "center", size: 8.5, color: MUTED });
      tx(t("th", "admin.persona.payroll.payslip.dateLabel"), L + sw + 40, y + 41, sw, { align: "center", size: 8.5, color: MUTED });

      // ── footer ──
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        doc.page.margins.bottom = 0;
        const fy = doc.page.height - 30;
        doc.moveTo(L, fy - 4).lineTo(R, fy - 4).strokeColor(LINE).lineWidth(0.5).stroke();
        tx(`สลิปค่าตอบแทนรายเดือน · ${monthText}`, L, fy, W * 0.7, { size: 7.5, color: "#9ca3af" });
        tx(`หน้า ${i + 1}/${range.count}`, R - 80, fy, 80, { size: 7.5, color: "#9ca3af", align: "right" });
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}
