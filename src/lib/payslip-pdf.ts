// A4 PDF of a pay-round payslip (owner 2026-11-24: a laid-out PDF, not the browser print dialog). Same data and the
// same derived figures (payslipFigures) as PayslipDocument. `audience: "staff"` (an employee's own slip) hides what
// the owner withholds from staff: the branch-wide SVC pool, the "แก้ไข" badge and the bank account.

import PDFDocument from "pdfkit";
import path from "node:path";
import { t } from "./i18n";
import { nameWithPrefix } from "./name";
import { payslipFigures, type PayslipView } from "./payslip";

const FONT_REG = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Regular.ttf");
const FONT_BOLD = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Bold.ttf");
const INK = "#1f2937", MUTED = "#6b7280", LINE = "#d1d5db", SOFT = "#f3f4f6", GREEN = "#0f6e56", RED = "#a32d2d", VIOLET = "#6d28d9";

const TH_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const longDate = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return `${dd} ${TH_MONTHS[m - 1]} พ.ศ. ${y + 543}`; };
const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const maskAccount = (acc: string | null) => { if (!acc) return "—"; const d = acc.replace(/\D/g, ""); return d.length < 8 ? acc : `${d.slice(0, 3)}-x-xxxxx-${d.slice(-1)}`; };
/** "9 ชม. 30 น." — the compact form for table cells */
function fmtMinShort(min: number): string {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  if (h === 0 && m === 0) return "—";
  return `${h ? `${h} ชม.` : ""}${h && m ? " " : ""}${m ? `${m} น.` : ""}`;
}
function fmtMin(min: number): string {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  if (h === 0 && m === 0) return "—";
  if (h === 0) return `${m} นาที`;
  if (m === 0) return `${h} ชั่วโมง`;
  return `${h} ชั่วโมง ${m} นาที`;
}

export function generatePayslipPdf(view: PayslipView, audience: "admin" | "staff"): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const { period, line, profile, svcSummary, svcRow, payslipBranchName, dayLog, doublePremium, restDayPremium } = view;
      const F = payslipFigures(view);
      const isAdmin = audience === "admin";
      const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: true, info: { Title: "Payslip", Author: "NOKHOOK OS" } });
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
      const rule = () => { doc.moveTo(L, y).lineTo(R, y).strokeColor(LINE).lineWidth(0.5).stroke(); y += 4; };

      // ── header ─────────────────────────────────────────────
      doc.font("th-b").fontSize(18).fillColor(INK).text("IKIGAI MEDIHEALTH", L, y, { width: W, align: "center" }); y = doc.y;
      doc.font("th").fontSize(8).fillColor(MUTED).text(t("th", "admin.persona.payroll.payslip.companyHint"), L, y, { width: W, align: "center" }); y = doc.y + 2;
      doc.moveTo(L, y).lineTo(R, y).strokeColor(INK).lineWidth(1.4).stroke(); y += 10;
      doc.font("th-b").fontSize(15).fillColor(INK).text(t("th", "admin.persona.payroll.payslip.title"), L, y, { width: W, align: "center" }); y = doc.y + 8;

      // ── employee + period ──────────────────────────────────
      const employment = line.employment_type === "pt" ? t("th", "admin.persona.employees.employment.pt") : line.employment_type === "ft" ? t("th", "admin.persona.employees.employment.ft") : "—";
      const taxMode = line.salary_tax_mode_snapshot === "wht" ? t("th", "admin.persona.employees.taxMode.wht") : t("th", "admin.persona.employees.taxMode.sso");
      const info: Array<[string, string]> = [
        [t("th", "admin.persona.payroll.payslip.employeeName"), nameWithPrefix(profile?.title_prefix ?? null, line.display_name)],
        [t("th", "admin.persona.payroll.payslip.employeeCode"), profile?.employee_code ?? line.employee_code ?? "—"],
        [t("th", "admin.persona.payroll.payslip.employmentType"), employment],
        [t("th", "admin.persona.payroll.payslip.taxMode"), taxMode],
        [t("th", "admin.persona.payroll.payslip.period"), `${longDate(period.period_start)} – ${longDate(period.period_end)}`],
        [t("th", "admin.persona.payroll.payslip.payDate"), longDate(period.pay_date)]
      ];
      doc.roundedRect(L, y, W, 78, 5).fillColor("#faf7f1").fill();
      info.forEach(([k, v], i) => {
        const col = i < 4 ? i % 2 : 0, row = i < 4 ? Math.floor(i / 2) : 2 + (i - 4);
        const x = L + 12 + col * (W / 2), yy = y + 9 + row * 17;
        tx(`${k}:`, x, yy, 92, { color: MUTED, size: 9 });
        tx(v, x + 94, yy, (i >= 4 ? W - 120 : W / 2 - 110), { font: "th-b", size: 9.5 });
      });
      y += 90;

      // ── summary: income / deductions / net ─────────────────
      const half = (W - 12) / 2;
      const boxRows = (title: string, color: string, rows: Array<[string, number, string?]>, totalLabel: string, total: number, totalColor: string, x: number, top: number) => {
        let yy = top;
        doc.rect(x, yy, half, 22).fillColor(color).fill();
        tx(title, x + 10, yy + 5, half - 20, { font: "th-b", size: 10.5 });
        yy += 22;
        doc.rect(x, yy, half, 0.1).strokeColor(LINE).stroke();
        for (const [label, v, sub] of rows) {
          const h = sub ? 26 : 18;
          tx(label, x + 10, yy + 4, half * 0.62, { size: 9 });
          tx(money(v), x + half * 0.55, yy + 4, half * 0.45 - 10, { align: "right", size: 9.5 });
          if (sub) tx(sub, x + 10, yy + 14, half - 20, { size: 7.5, color: "#9ca3af" });
          yy += h;
          doc.moveTo(x + 6, yy).lineTo(x + half - 6, yy).strokeColor("#eeeeee").lineWidth(0.4).stroke();
        }
        if (rows.length === 0) { tx(t("th", "admin.persona.payroll.payslip.noDeductions"), x + 10, yy + 4, half - 20, { color: "#9ca3af", size: 9 }); yy += 18; }
        doc.rect(x, yy, half, 22).fillColor(SOFT).fill();
        tx(totalLabel, x + 10, yy + 5, half * 0.5, { font: "th-b", size: 10 });
        tx(money(total), x + half * 0.5, yy + 5, half * 0.5 - 10, { font: "th-b", size: 10.5, align: "right", color: totalColor });
        doc.rect(x, top, half, yy + 22 - top).strokeColor(LINE).lineWidth(0.7).stroke();
        return yy + 22;
      };
      const inc: Array<[string, number, string?]> = [];
      if (F.wageComp > 0) inc.push(["ค่าตอบแทน", F.wageComp, [payslipBranchName ?? "", line.ot_pay > 0 ? `รวมค่าล่วงเวลา ฿${money(line.ot_pay)}` : ""].filter(Boolean).join(" · ") || undefined]);
      if (line.special_payment > 0) inc.push(["เงินช่วยเหลือพิเศษ", line.special_payment]);
      if (F.svcGrossRound > 0) inc.push(["เซอร์วิสชาร์จ", F.svcGrossRound, line.employment_type === "pt" ? "หักภาษี ณ ที่จ่าย" : "ไม่หักภาษี ณ ที่จ่าย"]);
      const ded: Array<[string, number, string?]> = [];
      if (line.sso_amount > 0) ded.push([t("th", "admin.persona.payroll.col.sso"), line.sso_amount]);
      if (F.whtTotalRound > 0) ded.push([t("th", "admin.persona.payroll.col.tax"), F.whtTotalRound, F.svcWhtRound > 0 ? "รวมหักจากเซอร์วิสชาร์จ" : undefined]);
      if (line.drink_deductions > 0) ded.push([t("th", "admin.persona.payroll.col.drinkDed"), line.drink_deductions]);
      if (line.mealpass_deductions > 0) ded.push([t("th", "admin.persona.payroll.col.mealpassDed"), line.mealpass_deductions]);
      if (line.other_deductions > 0) ded.push([t("th", "admin.persona.payroll.col.otherDed"), line.other_deductions]);
      if (line.special_paid_out > 0) ded.push(["หักเงินที่จ่ายล่วงหน้าแล้ว", line.special_paid_out]);
      if (F.svcGiRound > 0) ded.push(["เบี้ยประกันกลุ่ม", F.svcGiRound, "หักจากเซอร์วิสชาร์จ"]);
      ensure(150);
      const e1 = boxRows("รายได้", "#e6f4ee", inc, "รวมรายได้ทั้งหมด", F.incomeTotalRound, INK, L, y);
      const e2 = boxRows("รายการหัก", "#fbe9e9", ded, "รวมรายการหัก", F.dedTotalRound, RED, L + half + 12, y);
      y = Math.max(e1, e2) + 12;

      ensure(80);
      doc.rect(L, y, W, 66).lineWidth(1.6).strokeColor(INK).stroke();
      tx("รายได้รวมก่อนหัก", L + 14, y + 8, 160, { color: MUTED, size: 9.5 });
      tx(`${money(F.incomeTotalRound)} บาท`, L + 160, y + 8, W - 174, { align: "right", size: 10.5 });
      tx("รวมรายการหัก", L + 14, y + 24, 160, { color: MUTED, size: 9.5 });
      tx(`− ${money(F.dedTotalRound)} บาท`, L + 160, y + 24, W - 174, { align: "right", size: 10.5, color: RED });
      doc.moveTo(L + 10, y + 40).lineTo(R - 10, y + 40).strokeColor(LINE).lineWidth(0.6).stroke();
      tx(`${t("th", "admin.persona.payroll.payslip.netLabel")} (จำนวนที่ได้รับจริง)`, L + 14, y + 45, W * 0.55, { font: "th-b", size: 11 });
      tx(`${money(F.netTotalRound)} บาท`, L + W * 0.5, y + 42, W * 0.5 - 14, { font: "th-b", size: 16, color: GREEN, align: "right" });
      y += 74;
      if (isAdmin && profile?.bank_name && profile.bank_account) {
        tx(`${t("th", "admin.persona.payroll.payslip.transferTo")}: ${profile.bank_name} ${maskAccount(profile.bank_account)}`, L + 4, y, W, { color: MUTED, size: 9 }); y += 16;
      }
      y += 4;

      // ── work + how it was worked out ───────────────────────
      section(t("th", "admin.persona.payroll.payslip.workSection"));
      kv(t("th", "admin.persona.payroll.payslip.regularHours"), fmtMin(line.regular_minutes));
      kv(t("th", "admin.persona.payroll.payslip.otHours"), fmtMin(line.ot_minutes));
      if (line.holiday_minutes > 0) kv(t("th", "admin.persona.payroll.payslip.holidayHours"), fmtMin(line.holiday_minutes));
      kv(t("th", "admin.persona.payroll.payslip.daysWorked"), String(line.days_worked));
      if (line.leave_days > 0) kv(t("th", "admin.persona.payroll.payslip.leaveDays"), String(line.leave_days));
      if (line.unpaid_leave_days > 0) {
        kv("วันลาโดยไม่รับค่าจ้าง/ขาดงาน", `${line.unpaid_leave_days} วัน`, {
          note: line.unpaid_leave_deduction > 0 ? `หักจากเงินเดือนแล้ว ฿${money(line.unpaid_leave_deduction)}${line.monthly_salary_snapshot != null ? ` = เงินเดือน ${money(line.monthly_salary_snapshot)} ÷ 30 × ${line.unpaid_leave_days}` : ""}` : undefined
        });
      }
      if (line.employment_type === "pt" && line.hourly_rate_snapshot != null) kv(t("th", "admin.persona.payroll.payslip.hourlyRate"), `${money(line.hourly_rate_snapshot)} ${t("th", "admin.persona.employees.bahtPerHour")}`);
      if (line.employment_type === "ft" && line.monthly_salary_snapshot != null) kv(t("th", "admin.persona.payroll.payslip.monthlySalary"), `${money(line.monthly_salary_snapshot)} บาท`);
      if (line.employment_type === "ft" && line.pay_cycle_snapshot === "monthly" && line.unpaid_leave_days === 0 && line.monthly_salary_snapshot != null && line.monthly_salary_snapshot > 0 && line.base_pay > 0 && line.base_pay < line.monthly_salary_snapshot) {
        kv("ค่าตอบแทนคำนวณตามจำนวนวันที่ปฏิบัติงาน", `${Math.round((line.base_pay * 30) / line.monthly_salary_snapshot)} วัน`, { note: `เงินเดือน ฿${money(line.monthly_salary_snapshot)} ÷ 30 วัน × จำนวนวันที่ปฏิบัติงาน` });
      }
      if (restDayPremium > 0) kv("ค่าทำงานวันหยุดส่วนเพิ่ม (รวมในค่าล่วงเวลา)", `฿${money(restDayPremium)}`);
      if (doublePremium > 0) {
        const dd = dayLog.filter((d) => d.pairs.some((p) => p.double)).map((d) => longDate(d.date).replace(/ พ\.ศ\. \d+$/, "")).join(", ");
        kv("ค่าตอบแทนวันจ่ายสองเท่า (รวมในค่าล่วงเวลา)", `฿${money(doublePremium)}`, { note: dd ? `วันที่จ่ายสองเท่าซึ่งมาปฏิบัติงาน: ${dd}` : undefined });
      }

      if (svcRow) {
        y += 6; ensure(110);
        const svcMonthLabel = longDate(`${period.period_start.slice(0, 7)}-01`).replace(/^\d+\s/, "").replace(/ พ\.ศ\.\s/, " ");
        const rows: Array<[string, string, string?]> = [
          ["ชั่วโมงทำงานรวมในเดือนนี้", `${fmtMin(svcRow.totalMinutesWorked)} · ${svcRow.daysWorked} วัน`]
        ];
        if (isAdmin && svcSummary) rows.push(["เงินกองกลางของพนักงาน (ร้อยละ 60 ของยอดที่จัดเก็บได้)", `฿${money(svcSummary.staffPoolTotal)}`]);
        rows.push(["ส่วนแบ่งตามชั่วโมงทำงาน (ก่อนตัดสิทธิ์)", `฿${money(svcRow.grossAllocation)}`]);
        if (svcRow.attendance && svcRow.attendance.computable) {
          rows.push([`ขาด ${svcRow.attendance.absent} · ลา ${svcRow.attendance.leave} · สาย ${svcRow.attendance.late} ครั้ง จากวันตามตาราง`, `ร้อยละ ${svcRow.attendance.pct.toFixed(1)}${svcRow.forfeited || svcRow.halved ? "" : " (เกณฑ์ผ่าน)"}`]);
        } else if (!svcRow.attendance) {
          rows.push(["อัตราการเข้างานสาย", `ร้อยละ ${(svcRow.lateRatio * 100).toFixed(1)}${svcRow.forfeited ? "" : " (ไม่ถูกตัดสิทธิ์)"}`]);
        }
        if (svcRow.halved && (svcRow.penaltyAmount ?? 0) > 0) rows.push(["ได้รับครึ่งหนึ่งตามเกณฑ์ (ขาด ลา มาสาย เกินร้อยละ 20)", `−฿${money(svcRow.penaltyAmount ?? 0)}`]);
        if (svcRow.forfeited) rows.push(["ตัดสิทธิ์รับเซอร์วิสชาร์จ", svcRow.forfeitReason === "late_20pct" ? "เข้างานสายเกินร้อยละ 20" : svcRow.forfeitReason === "attendance" ? "ขาด ลา มาสาย เกินร้อยละ 50" : svcRow.forfeitReason === "resignation" ? "ลาออกระหว่างเดือน" : "—"]);
        const bh = 26 + rows.length * 15 + 20;
        ensure(bh + 4);
        doc.roundedRect(L, y, W, bh, 4).fillColor("#f8fafc").fill();
        doc.roundedRect(L, y, W, bh, 4).strokeColor(LINE).lineWidth(0.6).stroke();
        tx(`วิธีคำนวณเซอร์วิสชาร์จ ประจำเดือน${svcMonthLabel}`, L + 10, y + 6, W - 20, { font: "th-b", size: 9.5, color: VIOLET });
        let ry = y + 24;
        for (const [k, v] of rows) { tx(k, L + 10, ry, W * 0.66, { size: 8.5, color: "#475569" }); tx(v, L + W * 0.55, ry, W * 0.45 - 10, { size: 8.5, align: "right" }); ry += 15; }
        doc.moveTo(L + 10, ry).lineTo(R - 10, ry).strokeColor(LINE).lineWidth(0.5).stroke();
        tx("จำนวนเงินสุทธิที่ได้รับ", L + 10, ry + 4, W * 0.6, { font: "th-b", size: 9 });
        tx(`฿${money(svcRow.netAllocation)}`, L + W * 0.55, ry + 4, W * 0.45 - 10, { font: "th-b", size: 9.5, align: "right" });
        y += bh + 8;
      }

      // ── per-day log ────────────────────────────────────────
      if (dayLog.length > 0) {
        y += 6; ensure(70);
        tx("รายละเอียดการปฏิบัติงานรายวัน", L, y, W, { font: "th-b", size: 11 }); y += 17;
        const showPay = !view.ftMonthly;
        const widths = showPay ? [40, 74, 62, 98, 56, 0] : [40, 80, 70, 110, 0];
        widths[widths.length - 1] = W - widths.slice(0, -1).reduce((s, w) => s + w, 0);
        const heads = showPay ? ["วันที่", "เวลาเข้า–ออก", "ชั่วโมงทำงาน", "ค่าล่วงเวลา", "ค่าตอบแทน", "หมายเหตุ"] : ["วันที่", "เวลาเข้า–ออก", "ชั่วโมงทำงาน", "ค่าล่วงเวลา", "หมายเหตุ"];
        const xs = widths.map((_, i) => L + widths.slice(0, i).reduce((s, w) => s + w, 0));
        const head = () => {
          doc.rect(L, y, W, 18).fillColor(SOFT).fill();
          heads.forEach((h, i) => tx(h, xs[i] + 3, y + 4, widths[i] - 6, { font: "th-b", size: 8, align: i >= 2 && i < heads.length - 1 && i !== 1 ? "right" : "left" }));
          y += 18;
        };
        head();
        let sumPay = 0;
        dayLog.forEach((d, i) => {
          sumPay += d.pay;
          const worked = d.pairs.filter((p) => p.workIn || p.workOut);
          const first = worked[0], last = worked[worked.length - 1];
          const clock = first ? `${first.workIn ?? "—"}–${last?.workOut ?? "—"}` : (() => {
            const sp = d.pairs.find((p) => p.statusLabel === "ตามตารางกะ" && p.schedIn && p.schedOut);
            return sp ? `${sp.schedIn}–${sp.schedOut}` : (d.pairs.find((p) => p.statusLabel)?.statusLabel ?? "—");
          })();
          const isDouble = d.pairs.some((p) => p.double), isSpecial = d.pairs.some((p) => p.holiday), isRest = d.pairs.some((p) => p.restDay);
          const status = d.pairs.find((p) => p.statusLabel)?.statusLabel ?? null;
          const otAmt = Math.round((d.otPay + (isDouble || isRest ? d.premiumPay : 0)) * 100) / 100;
          const notes: string[] = [];
          if (isDouble) notes.push(`จ่ายสองเท่า${d.premiumPay > 0 ? ` (เบี้ย ฿${money(d.premiumPay)})` : ""}`);
          if (isRest && !isDouble) notes.push(`ทำงานวันหยุด${d.premiumPay > 0 ? ` (+฿${money(d.premiumPay)})` : ""}`);
          if (isSpecial && !isDouble) notes.push(`วันพิเศษ${d.premiumPay > 0 ? ` +฿${money(d.premiumPay)}` : ""}`);
          if (d.absenceDeduction > 0) notes.push(`หักวันขาดงาน −฿${money(d.absenceDeduction)}`);
          if (worked.length > 0 && status) notes.push(status);
          if (worked.length > 0 && d.pairs[0]?.branch) notes.push(d.pairs[0].branch);
          if (isAdmin && d.edited) notes.push("แก้ไข");
          const rh = 17;
          if (y + rh > bottom) { doc.addPage(); y = doc.page.margins.top; head(); }
          if (i % 2 === 1) doc.rect(L, y, W, rh).fillColor("#fafafa").fill();
          const cells = [d.date.slice(5), clock, d.effectiveMinutes > 0 ? fmtMinShort(d.effectiveMinutes) : "—",
            d.otMinutes === 0 && otAmt === 0 ? "—" : `${d.otMinutes > 0 ? fmtMinShort(d.otMinutes) : ""}${otAmt > 0 ? `${d.otMinutes > 0 ? " " : ""}฿${money(otAmt)}` : ""}`];
          if (showPay) cells.push(d.pay > 0 ? money(d.pay) : "—");
          cells.push(notes.join(" · "));
          cells.forEach((c, k) => tx(c, xs[k] + 3, y + 4, widths[k] - 6, { size: 8, align: k >= 2 && k < cells.length - 1 ? "right" : "left", color: k === cells.length - 1 ? MUTED : INK }));
          y += rh;
        });
        if (showPay && sumPay > 0) {
          if (y + 20 > bottom) { doc.addPage(); y = doc.page.margins.top; }
          doc.moveTo(L, y).lineTo(R, y).strokeColor("#9ca3af").lineWidth(0.8).stroke();
          tx("รวมค่าตอบแทนในงวด", L + 3, y + 4, widths[0] + widths[1] + widths[2] + widths[3] - 6, { font: "th-b", size: 8.5 });
          tx(money(sumPay), xs[4] + 3, y + 4, widths[4] - 6, { font: "th-b", size: 8.5, align: "right" });
          y += 20;
        }
      }

      // ── signatures ─────────────────────────────────────────
      y += 18;
      ensure(70);
      const sw = (W - 40) / 2;
      doc.moveTo(L + 8, y + 36).lineTo(L + sw - 8, y + 36).strokeColor("#6b7280").lineWidth(0.8).stroke();
      doc.moveTo(L + sw + 40 + 8, y + 36).lineTo(R - 8, y + 36).stroke();
      tx(t("th", "admin.persona.payroll.payslip.employeeSignature"), L, y + 41, sw, { align: "center", size: 8.5, color: MUTED });
      tx(t("th", "admin.persona.payroll.payslip.dateLabel"), L + sw + 40, y + 41, sw, { align: "center", size: 8.5, color: MUTED });
      y += 62;

      // ── footer on every page ───────────────────────────────
      const status = t("th", `admin.persona.payroll.status.${period.status}` as never);
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const saved = doc.page.margins.bottom; doc.page.margins.bottom = 0;
        const fy = doc.page.height - 30;
        tx(t("th", "admin.persona.payroll.payslip.footnote", { status }), L, fy, W * 0.78, { size: 7, color: "#9ca3af" });
        tx(`หน้า ${i - range.start + 1} / ${range.count}`, R - 80, fy, 80, { size: 7, color: "#9ca3af", align: "right" });
        doc.page.margins.bottom = saved;
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}
