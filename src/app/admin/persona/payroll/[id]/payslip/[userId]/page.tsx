import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { requirePayrollAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t, type Lang } from "@/lib/i18n";
import { formatLongDate } from "@/lib/time";
import { fmtMoney } from "@/lib/format";
import { nameWithPrefix } from "@/lib/name";
import { computeMonthlySvcSummary } from "@/lib/service-charge";
import PayslipPrintButton from "./PayslipPrintButton";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "สลิปค่าตอบแทน · PERSONA" };

type Period = {
  id: number;
  cycle: "weekly" | "monthly";
  target: "pt" | "ft" | "all";
  period_start: string;
  period_end: string;
  pay_date: string;
  status: "draft" | "finalized" | "paid" | "cancelled";
  branch_id: number | null;
};

type Line = {
  user_id: number;
  employee_code: string | null;
  display_name: string;
  employment_type: "pt" | "ft" | null;
  pay_cycle_snapshot: "weekly" | "monthly" | null;
  hourly_rate_snapshot: number | null;
  monthly_salary_snapshot: number | null;
  salary_tax_mode_snapshot: "sso" | "wht" | null;
  shift_minutes: number;
  break_deducted_minutes: number;
  regular_minutes: number;
  ot_minutes: number;
  holiday_minutes: number;
  days_worked: number;
  leave_days: number;
  unpaid_leave_days: number;
  unpaired_clockins: number;
  base_pay: number;
  ot_pay: number;
  service_charge: number;
  other_additions: number;
  gross_pay: number;
  sso_amount: number;
  drink_deductions: number;
  tax_amount: number;
  other_deductions: number;
  net_pay: number;
};

type EmployeeProfile = {
  bank_name: string | null;
  bank_account: string | null;
  national_id: string | null;
  employee_code: string | null;
  title_prefix: string | null;
};

// fmtMoney moved to @/lib/format (2026-05) — imported above so every
// payroll surface shares an identical 2dp shape.

function fmtMin(min: number, lang: Lang): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0 && m === 0) return "—";
  if (lang === "th") {
    if (h === 0) return `${m} นาที`;
    if (m === 0) return `${h} ชั่วโมง`;
    return `${h} ชั่วโมง ${m} นาที`;
  }
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} hr`;
  return `${h} hr ${m} min`;
}

function maskAccount(acc: string | null): string {
  if (!acc) return "—";
  // Show first 3 + last 4, mask middle
  const digits = acc.replace(/\D/g, "");
  if (digits.length < 8) return acc;
  return `${digits.slice(0, 3)}-x-xxxxx-${digits.slice(-1)}`;
}

export default function PayslipPage({
  params
}: { params: { id: string; userId: string } }) {
  requirePayrollAccess();
  const lang = getLang();
  const db = getDb();

  const periodId = Number(params.id);
  const userId = Number(params.userId);
  if (!Number.isInteger(periodId) || !Number.isInteger(userId)) notFound();

  const period = db.prepare(`
    SELECT id, cycle, target, period_start, period_end, pay_date, status, branch_id
    FROM payroll_periods WHERE id = ?
  `).get(periodId) as Period | undefined;
  if (!period) notFound();

  const line = db.prepare(`
    SELECT user_id, employee_code, display_name, employment_type,
           pay_cycle_snapshot, hourly_rate_snapshot, monthly_salary_snapshot,
           salary_tax_mode_snapshot,
           shift_minutes, break_deducted_minutes, regular_minutes, ot_minutes,
           holiday_minutes,
           days_worked, leave_days, unpaid_leave_days, unpaired_clockins,
           base_pay, ot_pay, service_charge, other_additions, gross_pay,
           sso_amount, tax_amount, other_deductions, drink_deductions, net_pay
    FROM payroll_lines WHERE period_id = ? AND user_id = ?
  `).get(periodId, userId) as Line | undefined;
  if (!line) notFound();

  const profile = db.prepare(`
    SELECT bank_name, bank_account, national_id, employee_code, title_prefix FROM users WHERE id = ?
  `).get(userId) as EmployeeProfile | undefined;

  // Service-charge breakdown (display only) — owner 2026-07-13: "โชว์วิธี
  // คำนวณ service charge รายคน". When this line carries an SVC payout we
  // recompute the monthly SVC summary for the employee's branch and pull
  // their row so the payslip can explain *how* the figure was reached
  // (hours worked → share of the 60% staff pool → forfeiture). This never
  // alters pay amounts — line.service_charge remains the source of truth.
  // Branch resolution: prefer the period's branch; fall back to the
  // employee's branch (legacy periods carry branch_id = NULL).
  const svcMonth = period.period_start.slice(0, 7);
  let svcBranchId = period.branch_id;
  if (svcBranchId == null) {
    const ub = db.prepare(
      "SELECT branch_id FROM user_branches WHERE user_id = ? ORDER BY branch_id LIMIT 1"
    ).get(userId) as { branch_id: number } | undefined;
    svcBranchId = ub?.branch_id ?? null;
  }
  // Show the month's SVC on the payslip too (owner 2026-08-01: SVC เป็นเงินที่
  // พนักงานได้จริง ต้องอยู่ในสลิป). SVC is a SEPARATE monthly payout (ไม่อยู่ใน
  // net_pay ของรอบ) — so we surface it only on a MONTHLY payslip (a weekly PT
  // slip would show the whole month's SVC on every week = 4× over-report; PT
  // SVC is a separate monthly payout). The manual line.service_charge case
  // (already inside net_pay) keeps its explanation box as before.
  const svcSummary =
    svcBranchId != null && (line.service_charge > 0 || period.cycle === "monthly")
      ? computeMonthlySvcSummary(svcBranchId, svcMonth)
      : null;
  const svcRow = svcSummary?.rows.find((r) => r.userId === userId) ?? null;
  // Batch SVC counts as a SEPARATE payout on top of net_pay only when it isn't
  // already folded into the line (line.service_charge === 0) and this is the
  // monthly slip. Otherwise 0 (avoid double-count / weekly over-report).
  const svcSeparatePayout =
    line.service_charge === 0 && period.cycle === "monthly" ? (svcRow?.netPayout ?? 0) : 0;

  const employmentLabel =
    line.employment_type === "pt" ? t(lang, "admin.persona.employees.employment.pt") :
    line.employment_type === "ft" ? t(lang, "admin.persona.employees.employment.ft") :
    "—";

  const taxModeLabel =
    line.salary_tax_mode_snapshot === "wht"
      ? t(lang, "admin.persona.employees.taxMode.wht")
      : t(lang, "admin.persona.employees.taxMode.sso");

  return (
    <>
      {/* On-screen toolbar — hidden when printing */}
      <div className="space-y-3 print:hidden">
        <div className="flex items-center gap-3 flex-wrap">
          <Link href={`/admin/persona/payroll/${periodId}`} className="text-sm text-slate-500 hover:text-brand">
            ← {t(lang, "admin.persona.payroll.backToPeriod")}
          </Link>
          <PayslipPrintButton lang={lang} />
        </div>
      </div>

      {/* Payslip — visible both on screen and print */}
      <div className="payslip mx-auto bg-white text-slate-800 p-8 max-w-2xl rounded-2xl shadow-card mt-3 print:shadow-none print:rounded-none print:p-6 print:max-w-none">
        {/* Header */}
        <div className="text-center border-b-2 border-slate-300 pb-3 mb-4">
          <div className="text-2xl font-bold tracking-wide">IKIGAI MEDIHEALTH</div>
          <div className="text-xs text-slate-500 mt-0.5">
            {t(lang, "admin.persona.payroll.payslip.companyHint")}
          </div>
          <h1 className="text-xl font-semibold mt-3">
            {t(lang, "admin.persona.payroll.payslip.title")}
          </h1>
        </div>

        {/* Employee + period info — 2 columns */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm mb-4">
          <Row label={t(lang, "admin.persona.payroll.payslip.employeeName")} value={nameWithPrefix(profile?.title_prefix ?? null, line.display_name)} />
          <Row label={t(lang, "admin.persona.payroll.payslip.employeeCode")} value={profile?.employee_code ?? line.employee_code ?? "—"} />
          <Row label={t(lang, "admin.persona.payroll.payslip.employmentType")} value={employmentLabel} />
          <Row label={t(lang, "admin.persona.payroll.payslip.taxMode")} value={taxModeLabel} />
          <Row
            label={t(lang, "admin.persona.payroll.payslip.period")}
            value={`${formatLongDate(period.period_start, lang)} – ${formatLongDate(period.period_end, lang)}`}
            colSpan2
          />
          <Row label={t(lang, "admin.persona.payroll.payslip.payDate")} value={formatLongDate(period.pay_date, lang)} colSpan2 />
        </div>

        {/* Work breakdown */}
        <Section title={t(lang, "admin.persona.payroll.payslip.workSection")}>
          <KV label={t(lang, "admin.persona.payroll.payslip.regularHours")} value={fmtMin(line.regular_minutes, lang)} />
          <KV label={t(lang, "admin.persona.payroll.payslip.otHours")} value={fmtMin(line.ot_minutes, lang)} />
          {line.holiday_minutes > 0 && (
            <KV label={t(lang, "admin.persona.payroll.payslip.holidayHours")} value={fmtMin(line.holiday_minutes, lang)} />
          )}
          <KV label={t(lang, "admin.persona.payroll.payslip.daysWorked")} value={String(line.days_worked)} />
          {line.leave_days > 0 && (
            <KV label={t(lang, "admin.persona.payroll.payslip.leaveDays")} value={String(line.leave_days)} />
          )}
          {line.unpaid_leave_days > 0 && (
            <KV label="ลาไม่รับค่าจ้าง"
              value={`${line.unpaid_leave_days} วัน${
                line.monthly_salary_snapshot != null
                  ? ` (หัก ฿${fmtMoney((line.monthly_salary_snapshot / 30) * line.unpaid_leave_days)} จากฐานเงินเดือนแล้ว)`
                  : ""}`} />
          )}
          {line.employment_type === "pt" && line.hourly_rate_snapshot != null && (
            <KV label={t(lang, "admin.persona.payroll.payslip.hourlyRate")} value={`${fmtMoney(line.hourly_rate_snapshot)} ${t(lang, "admin.persona.employees.bahtPerHour")}`} />
          )}
          {line.employment_type === "ft" && line.monthly_salary_snapshot != null && (
            <KV label={t(lang, "admin.persona.payroll.payslip.monthlySalary")} value={`${fmtMoney(line.monthly_salary_snapshot)} บาท`} />
          )}
        </Section>

        {/* Earnings */}
        <Section title={t(lang, "admin.persona.payroll.payslip.earningsSection")}>
          <Money label={t(lang, "admin.persona.payroll.col.basePay")} value={line.base_pay} />
          {/* FT hire/resignation-month proration note (owner 2026-07-15). Shown
              only for a monthly-cycle FT whose base is below full salary WITHOUT
              unpaid leave. Gated to pay_cycle="monthly" + base>0 so it never
              fires on a weekly-transition line (base = salary/#Mondays) or a
              non-primary-branch line (base 0 by the home-branch rule). */}
          {line.employment_type === "ft" && line.pay_cycle_snapshot === "monthly" &&
            line.unpaid_leave_days === 0 && line.monthly_salary_snapshot != null &&
            line.monthly_salary_snapshot > 0 && line.base_pay > 0 &&
            line.base_pay < line.monthly_salary_snapshot && (
            <div className="-mt-1 mb-1.5 text-[11px] text-slate-500">
              เฉลี่ยจากวันที่มาทำงาน {Math.round((line.base_pay * 30) / line.monthly_salary_snapshot)} วัน
              (เงินเดือน ฿{fmtMoney(line.monthly_salary_snapshot)} ÷ 30 × วันทำงาน)
            </div>
          )}
          {line.ot_pay > 0 && (
            <Money label={t(lang, "admin.persona.payroll.col.otPay")} value={line.ot_pay} />
          )}
          {line.service_charge > 0 && (
            <Money label={t(lang, "admin.persona.payroll.col.svc")} value={line.service_charge} />
          )}
          {svcRow && (
            <div className="mt-1 mb-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 print:bg-transparent">
              <div className="font-medium text-slate-700 mb-1">
                วิธีคำนวณเซอร์วิสชาร์จ ({formatLongDate(`${svcMonth}-01`, lang).replace(/^\d+\s/, "")})
              </div>
              <div className="flex justify-between py-0.5">
                <span>ชั่วโมงทำงานเดือนนี้</span>
                <span className="tabular-nums">{fmtMin(svcRow.totalMinutesWorked, lang)} · {svcRow.daysWorked} วัน</span>
              </div>
              {svcSummary && (
                <div className="flex justify-between py-0.5">
                  <span>กองกลางพนักงาน (60% ของยอดที่เก็บได้)</span>
                  <span className="tabular-nums">฿{fmtMoney(svcSummary.staffPoolTotal)}</span>
                </div>
              )}
              <div className="flex justify-between py-0.5">
                <span>ส่วนแบ่งตามชั่วโมง (ก่อนหักริบ)</span>
                <span className="tabular-nums">฿{fmtMoney(svcRow.grossAllocation)}</span>
              </div>
              <div className="flex justify-between py-0.5">
                <span>อัตราเข้างานสาย</span>
                <span className="tabular-nums">
                  {(svcRow.lateRatio * 100).toFixed(1)}%
                  {svcRow.forfeited ? "" : " (ไม่ถูกริบ)"}
                </span>
              </div>
              {svcRow.forfeited ? (
                <div className="flex justify-between py-0.5 text-rose-600">
                  <span>ริบเซอร์วิสชาร์จ</span>
                  <span>
                    {svcRow.forfeitReason === "late_20pct"
                      ? "สายเกิน 20%"
                      : svcRow.forfeitReason === "resignation"
                        ? "ลาออก"
                        : "—"}
                  </span>
                </div>
              ) : null}
              <div className="flex justify-between py-0.5 border-t border-slate-200 mt-1 pt-1 font-medium text-slate-700">
                <span>ยอดสุทธิที่ได้รับ</span>
                <span className="tabular-nums">฿{fmtMoney(svcRow.netAllocation)}</span>
              </div>
            </div>
          )}
          {line.other_additions > 0 && (
            <Money label={t(lang, "admin.persona.payroll.col.otherAdd")} value={line.other_additions} />
          )}
          <Money
            label={t(lang, "admin.persona.payroll.payslip.grossLabel")}
            value={line.gross_pay}
            bold
          />
        </Section>

        {/* Deductions */}
        <Section title={t(lang, "admin.persona.payroll.payslip.deductionsSection")}>
          {line.sso_amount > 0 && (
            <Money label={t(lang, "admin.persona.payroll.col.sso")} value={line.sso_amount} />
          )}
          {line.tax_amount > 0 && (
            <Money label={t(lang, "admin.persona.payroll.col.tax")} value={line.tax_amount} />
          )}
          {line.other_deductions > 0 && (
            <Money label={t(lang, "admin.persona.payroll.col.otherDed")} value={line.other_deductions} />
          )}
          {line.drink_deductions > 0 && (
            <Money label={t(lang, "admin.persona.payroll.col.drinkDed")} value={line.drink_deductions} />
          )}
          {line.sso_amount === 0 && line.tax_amount === 0 && line.other_deductions === 0 && line.drink_deductions === 0 && (
            <div className="text-sm text-slate-400 italic py-1">
              {t(lang, "admin.persona.payroll.payslip.noDeductions")}
            </div>
          )}
          <Money
            label={t(lang, "admin.persona.payroll.payslip.totalDeductions")}
            value={line.sso_amount + line.tax_amount + line.other_deductions + line.drink_deductions}
            bold
          />
        </Section>

        {/* Net pay — emphasised */}
        <div className="border-2 border-slate-800 rounded-lg p-4 my-4 bg-slate-50">
          <div className="flex items-baseline justify-between">
            <span className="text-base font-semibold">
              {t(lang, "admin.persona.payroll.payslip.netLabel")}
            </span>
            <span className="text-2xl font-bold">
              {fmtMoney(line.net_pay)} <span className="text-sm font-normal">บาท</span>
            </span>
          </div>
          {/* SVC is paid as a separate monthly payout — show it here so the
              payslip reflects the employee's full take (owner 2026-08-01). */}
          {svcSeparatePayout > 0 && (
            <>
              <div className="flex items-baseline justify-between mt-2 text-slate-600">
                <span className="text-sm">
                  + เซอร์วิสชาร์จ <span className="text-xs text-slate-400">(จ่ายแยก ~วันที่ 20 เดือนถัดไป)</span>
                </span>
                <span className="text-lg font-semibold text-violet-700">
                  {fmtMoney(svcSeparatePayout)} <span className="text-xs font-normal">บาท</span>
                </span>
              </div>
              <div className="flex items-baseline justify-between mt-2 border-t border-slate-300 pt-2">
                <span className="text-base font-bold">รวมรับจริงทั้งเดือน</span>
                <span className="text-2xl font-bold text-emerald-700">
                  {fmtMoney(line.net_pay + svcSeparatePayout)} <span className="text-sm font-normal">บาท</span>
                </span>
              </div>
            </>
          )}
          {profile?.bank_name && profile.bank_account && (
            <div className="text-xs text-slate-600 mt-2">
              {t(lang, "admin.persona.payroll.payslip.transferTo")}:{" "}
              <span className="font-medium">{profile.bank_name}</span>{" "}
              {maskAccount(profile.bank_account)}
            </div>
          )}
        </div>

        {/* Signature block */}
        <div className="grid grid-cols-2 gap-8 mt-10 text-sm">
          <div>
            <div className="border-b border-slate-400 h-8"></div>
            <div className="text-center mt-1 text-slate-500 text-xs">
              {t(lang, "admin.persona.payroll.payslip.employeeSignature")}
            </div>
          </div>
          <div>
            <div className="border-b border-slate-400 h-8"></div>
            <div className="text-center mt-1 text-slate-500 text-xs">
              {t(lang, "admin.persona.payroll.payslip.dateLabel")}
            </div>
          </div>
        </div>

        <div className="mt-8 text-center text-[10px] text-slate-400">
          {t(lang, "admin.persona.payroll.payslip.footnote", {
            status: t(lang, `admin.persona.payroll.status.${period.status}` as any)
          })}
        </div>
      </div>
    </>
  );
}

// ── Helper components ────────────────────────────────────────────────

function Row({ label, value, colSpan2 }: { label: string; value: string; colSpan2?: boolean }) {
  return (
    <div className={colSpan2 ? "col-span-2 flex" : "flex"}>
      <span className="text-slate-500 mr-2 whitespace-nowrap">{label}:</span>
      <span className="font-medium text-slate-700">{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="my-3">
      <div className="text-sm font-semibold text-slate-700 border-b border-slate-200 pb-1 mb-1">
        {title}
      </div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-slate-600">{label}</span>
      <span className="text-slate-800">{value}</span>
    </div>
  );
}

function Money({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <div className={`flex justify-between py-0.5 ${bold ? "border-t border-slate-300 font-semibold mt-1 pt-1" : ""}`}>
      <span className={bold ? "text-slate-800" : "text-slate-600"}>{label}</span>
      <span className="text-slate-800 font-mono tabular-nums">{fmtMoney(value)}</span>
    </div>
  );
}
