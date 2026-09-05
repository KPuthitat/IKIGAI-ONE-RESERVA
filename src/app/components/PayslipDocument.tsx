import type { ReactNode } from "react";
import { t, type Lang } from "@/lib/i18n";
import { formatLongDate } from "@/lib/time";
import { fmtMoney } from "@/lib/format";
import { nameWithPrefix } from "@/lib/name";
import type { PayslipView } from "@/lib/payslip";

// Shared payslip document (owner 2026-09-05). Presentational only — the admin
// payslip page and the staff self-service payslip both render this so an
// employee sees exactly what the admin does, including the per-day time log and
// the "เพิ่มอื่นๆ" (double-pay premium) explanation for dispute resolution.

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
  const digits = acc.replace(/\D/g, "");
  if (digits.length < 8) return acc;
  return `${digits.slice(0, 3)}-x-xxxxx-${digits.slice(-1)}`;
}

export default function PayslipDocument({ lang, view }: { lang: Lang; view: PayslipView }) {
  const { period, line, profile, svcSummary, svcRow, payslipBranchName, dayLog, doublePremium } = view;

  const isPt = line.employment_type === "pt";
  const usesMonthlySvc = period.cycle === "monthly" && svcRow != null;
  const wageComp = line.base_pay + line.ot_pay + line.other_additions + line.meeting_fee;
  const svcGrossRound = usesMonthlySvc ? (svcRow?.netAllocation ?? 0) : line.service_charge;
  const svcWhtRound = usesMonthlySvc ? (svcRow?.whtAmount ?? 0) : 0;
  const svcGiRound = usesMonthlySvc ? (svcRow?.groupInsurance ?? 0) : 0;
  const incomeTotalRound = wageComp + svcGrossRound;
  const whtTotalRound = line.tax_amount + svcWhtRound;
  const dedTotalRound = line.sso_amount + whtTotalRound + line.drink_deductions + line.mealpass_deductions + line.other_deductions + svcGiRound;
  const netTotalRound = incomeTotalRound - dedTotalRound;
  const svcMonth = period.period_start.slice(0, 7);

  // Days worked on วันจ่ายสองเท่า (×2) — the source of the double-pay premium
  // carried in other_additions. Surfaced so the premium is never a mystery.
  const doubleDates = dayLog.filter((d) => d.pairs.some((p) => p.double)).map((d) => d.date);
  // The non-double-pay remainder of other_additions (admin adjustment, referral
  // reward, doctor fee, …) so the two figures always reconcile to the total.
  const otherRemainder = Math.round((line.other_additions - doublePremium) * 100) / 100;

  const employmentLabel =
    line.employment_type === "pt" ? t(lang, "admin.persona.employees.employment.pt") :
    line.employment_type === "ft" ? t(lang, "admin.persona.employees.employment.ft") : "—";
  const taxModeLabel =
    line.salary_tax_mode_snapshot === "wht"
      ? t(lang, "admin.persona.employees.taxMode.wht")
      : t(lang, "admin.persona.employees.taxMode.sso");

  return (
    <div className="payslip mx-auto bg-white text-slate-800 p-8 max-w-2xl rounded-2xl shadow-card mt-3 print:shadow-none print:rounded-none print:p-6 print:max-w-none">
      {/* Header */}
      <div className="text-center border-b-2 border-slate-300 pb-3 mb-4">
        <div className="text-2xl font-bold tracking-wide">IKIGAI MEDIHEALTH</div>
        <div className="text-xs text-slate-500 mt-0.5">{t(lang, "admin.persona.payroll.payslip.companyHint")}</div>
        <h1 className="text-xl font-semibold mt-3">{t(lang, "admin.persona.payroll.payslip.title")}</h1>
      </div>

      {/* Employee + period info */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm mb-4">
        <Row label={t(lang, "admin.persona.payroll.payslip.employeeName")} value={nameWithPrefix(profile?.title_prefix ?? null, line.display_name)} />
        <Row label={t(lang, "admin.persona.payroll.payslip.employeeCode")} value={profile?.employee_code ?? line.employee_code ?? "—"} />
        <Row label={t(lang, "admin.persona.payroll.payslip.employmentType")} value={employmentLabel} />
        <Row label={t(lang, "admin.persona.payroll.payslip.taxMode")} value={taxModeLabel} />
        <Row label={t(lang, "admin.persona.payroll.payslip.period")}
          value={`${formatLongDate(period.period_start, lang)} – ${formatLongDate(period.period_end, lang)}`} colSpan2 />
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
        {line.employment_type === "ft" && line.pay_cycle_snapshot === "monthly" &&
          line.unpaid_leave_days === 0 && line.monthly_salary_snapshot != null &&
          line.monthly_salary_snapshot > 0 && line.base_pay > 0 &&
          line.base_pay < line.monthly_salary_snapshot && (
          <div className="-mt-1 mb-1.5 text-[11px] text-slate-500">
            เฉลี่ยจากวันที่มาทำงาน {Math.round((line.base_pay * 30) / line.monthly_salary_snapshot)} วัน
            (เงินเดือน ฿{fmtMoney(line.monthly_salary_snapshot)} ÷ 30 × วันทำงาน)
          </div>
        )}
        {line.ot_pay > 0 && <Money label={t(lang, "admin.persona.payroll.col.otPay")} value={line.ot_pay} />}
        {line.service_charge > 0 && <Money label={t(lang, "admin.persona.payroll.col.svc")} value={line.service_charge} />}
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
                {(svcRow.lateRatio * 100).toFixed(1)}%{svcRow.forfeited ? "" : " (ไม่ถูกริบ)"}
              </span>
            </div>
            {svcRow.forfeited ? (
              <div className="flex justify-between py-0.5 text-rose-600">
                <span>ริบเซอร์วิสชาร์จ</span>
                <span>
                  {svcRow.forfeitReason === "late_20pct" ? "สายเกิน 20%"
                    : svcRow.forfeitReason === "resignation" ? "ลาออก" : "—"}
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
        {/* Explain "เพิ่มอื่นๆ" — the double-pay premium (and any remainder) so an
            employee can see WHERE 295.83 etc. came from (owner 2026-09-05). */}
        {line.other_additions > 0 && (doublePremium > 0 || otherRemainder > 0) && (
          <div className="-mt-1 mb-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 print:bg-transparent">
            <div className="font-medium text-slate-700 mb-1">ที่มาของ “เพิ่มอื่นๆ”</div>
            {doublePremium > 0 && (
              <>
                <div className="flex justify-between py-0.5">
                  <span>เบี้ยวันจ่ายสองเท่า (ส่วนเพิ่ม ×1 เท่า)</span>
                  <span className="tabular-nums">฿{fmtMoney(doublePremium)}</span>
                </div>
                {line.monthly_salary_snapshot != null && line.monthly_salary_snapshot > 0 && (
                  <div className="text-[11px] text-slate-400 -mt-0.5 mb-0.5">
                    คิดจาก (ชั่วโมงทำงานในวันจ่ายสองเท่า) × (เงินเดือน ฿{fmtMoney(line.monthly_salary_snapshot)} ÷ 30 ÷ 8 = ฿{fmtMoney(line.monthly_salary_snapshot / 30 / 8)}/ชม.)
                  </div>
                )}
                {doubleDates.length > 0 && (
                  <div className="text-[11px] text-slate-400">
                    วันจ่ายสองเท่าที่ทำงาน: {doubleDates.map((d) => formatLongDate(d, lang).replace(/\s\d{4}$/, "")).join(", ")}
                  </div>
                )}
              </>
            )}
            {otherRemainder > 0 && (
              <div className="flex justify-between py-0.5 border-t border-slate-200 mt-1 pt-1">
                <span>รายการเพิ่มอื่น (เช่น ปรับโดยผู้ดูแล/ค่าแนะนำ/ค่าตอบแทนแพทย์)</span>
                <span className="tabular-nums">฿{fmtMoney(otherRemainder)}</span>
              </div>
            )}
          </div>
        )}
        {line.meeting_fee > 0 && <Money label="เบี้ยประชุม" value={line.meeting_fee} />}
        <Money label={t(lang, "admin.persona.payroll.payslip.grossLabel")} value={line.gross_pay} bold />
      </Section>

      {/* Deductions */}
      <Section title={t(lang, "admin.persona.payroll.payslip.deductionsSection")}>
        {line.sso_amount > 0 && <Money label={t(lang, "admin.persona.payroll.col.sso")} value={line.sso_amount} />}
        {line.tax_amount > 0 && <Money label={t(lang, "admin.persona.payroll.col.tax")} value={line.tax_amount} />}
        {line.other_deductions > 0 && <Money label={t(lang, "admin.persona.payroll.col.otherDed")} value={line.other_deductions} />}
        {line.drink_deductions > 0 && <Money label={t(lang, "admin.persona.payroll.col.drinkDed")} value={line.drink_deductions} />}
        {line.mealpass_deductions > 0 && <Money label={t(lang, "admin.persona.payroll.col.mealpassDed")} value={line.mealpass_deductions} />}
        {line.sso_amount === 0 && line.tax_amount === 0 && line.other_deductions === 0 && line.drink_deductions === 0 && line.mealpass_deductions === 0 && (
          <div className="text-sm text-slate-400 italic py-1">{t(lang, "admin.persona.payroll.payslip.noDeductions")}</div>
        )}
        <Money label={t(lang, "admin.persona.payroll.payslip.totalDeductions")}
          value={line.sso_amount + line.tax_amount + line.other_deductions + line.drink_deductions + line.mealpass_deductions} bold />
      </Section>

      {/* Plain-language summary */}
      <div className="space-y-3 my-4">
        <div className="rounded-lg border border-slate-200 overflow-hidden">
          <div className="bg-emerald-50 px-4 py-2 text-sm font-bold text-emerald-800">รายได้</div>
          <div className="px-4 py-2.5 space-y-1.5 text-sm">
            {wageComp > 0 && (
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-slate-600">
                  ค่าตอบแทน
                  <span className="font-medium text-slate-800">{payslipBranchName ? ` · ${payslipBranchName}` : ""}</span>
                  {line.ot_pay > 0 && <span className="text-xs text-slate-400"> · รวมโอที ฿{fmtMoney(line.ot_pay)}</span>}
                </span>
                <span className="tabular-nums font-medium text-slate-800">{fmtMoney(wageComp)}</span>
              </div>
            )}
            {svcGrossRound > 0 && (
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-slate-600">
                  เซอร์วิสชาร์จ{" "}
                  <span className="text-xs text-slate-400">
                    ({isPt ? "ถูกหักภาษี ณ ที่จ่าย" : "ไม่ถูกหักภาษี ณ ที่จ่าย"}{usesMonthlySvc ? " · จ่ายแยก ~วันที่ 20 เดือนถัดไป" : ""})
                  </span>
                </span>
                <span className="tabular-nums font-medium text-violet-700">{fmtMoney(svcGrossRound)}</span>
              </div>
            )}
            <div className="flex items-baseline justify-between gap-3 border-t border-slate-200 pt-1.5 mt-1.5 font-bold text-slate-800">
              <span>รวมรายได้ทั้งหมด</span>
              <span className="tabular-nums">{fmtMoney(incomeTotalRound)}</span>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 overflow-hidden">
          <div className="bg-rose-50 px-4 py-2 text-sm font-bold text-rose-800">รายการหัก</div>
          <div className="px-4 py-2.5 space-y-1.5 text-sm">
            {line.sso_amount > 0 && (
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-slate-600">{t(lang, "admin.persona.payroll.col.sso")}</span>
                <span className="tabular-nums font-medium text-slate-700">{fmtMoney(line.sso_amount)}</span>
              </div>
            )}
            {whtTotalRound > 0 && (
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-slate-600">
                  {t(lang, "admin.persona.payroll.col.tax")}{" "}
                  {svcWhtRound > 0 && <span className="text-xs text-slate-400">(หักจากเซอร์วิสชาร์จ)</span>}
                </span>
                <span className="tabular-nums font-medium text-slate-700">{fmtMoney(whtTotalRound)}</span>
              </div>
            )}
            {line.drink_deductions > 0 && (
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-slate-600">{t(lang, "admin.persona.payroll.col.drinkDed")}</span>
                <span className="tabular-nums font-medium text-slate-700">{fmtMoney(line.drink_deductions)}</span>
              </div>
            )}
            {line.mealpass_deductions > 0 && (
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-slate-600">{t(lang, "admin.persona.payroll.col.mealpassDed")}</span>
                <span className="tabular-nums font-medium text-slate-700">{fmtMoney(line.mealpass_deductions)}</span>
              </div>
            )}
            {line.other_deductions > 0 && (
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-slate-600">{t(lang, "admin.persona.payroll.col.otherDed")}</span>
                <span className="tabular-nums font-medium text-slate-700">{fmtMoney(line.other_deductions)}</span>
              </div>
            )}
            {svcGiRound > 0 && (
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-slate-600">ประกันกลุ่ม <span className="text-xs text-slate-400">(หักจากเซอร์วิสชาร์จ)</span></span>
                <span className="tabular-nums font-medium text-slate-700">{fmtMoney(svcGiRound)}</span>
              </div>
            )}
            {dedTotalRound === 0 && (
              <div className="text-sm text-slate-400 italic">{t(lang, "admin.persona.payroll.payslip.noDeductions")}</div>
            )}
            <div className="flex items-baseline justify-between gap-3 border-t border-slate-200 pt-1.5 mt-1.5 font-bold text-slate-800">
              <span>รวมรายการหัก</span>
              <span className="tabular-nums text-rose-600">{fmtMoney(dedTotalRound)}</span>
            </div>
          </div>
        </div>

        <div className="border-2 border-slate-800 rounded-lg p-4 bg-slate-50 space-y-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-semibold text-slate-700">รายได้ก่อนหัก (รวมรายรับทั้งหมด)</span>
            <span className="text-lg font-bold text-slate-800 whitespace-nowrap tabular-nums">
              {fmtMoney(incomeTotalRound)} <span className="text-xs font-normal">บาท</span>
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm text-slate-600">รวมรายการหัก</span>
            <span className="text-base font-semibold text-rose-600 whitespace-nowrap tabular-nums">
              − {fmtMoney(dedTotalRound)} <span className="text-xs font-normal">บาท</span>
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-3 border-t-2 border-slate-300 pt-1.5 mt-1.5">
            <span className="text-base font-bold">{t(lang, "admin.persona.payroll.payslip.netLabel")} (รับจริง)</span>
            <span className="text-2xl font-bold text-emerald-700 whitespace-nowrap tabular-nums">
              {fmtMoney(netTotalRound)} <span className="text-sm font-normal">บาท</span>
            </span>
          </div>
          {profile?.bank_name && profile.bank_account && (
            <div className="text-xs text-slate-600 mt-2 border-t border-slate-300 pt-2">
              {t(lang, "admin.persona.payroll.payslip.transferTo")}:{" "}
              <span className="font-medium">{profile.bank_name}</span> {maskAccount(profile.bank_account)}
            </div>
          )}
        </div>
      </div>

      {/* Per-day time log — the evidence behind the totals (owner 2026-09-05). */}
      {dayLog.length > 0 && (
        <div className="my-4">
          <div className="text-sm font-semibold text-slate-700 border-b border-slate-200 pb-1 mb-2">
            ตารางลงเวลารายวัน
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-200">
                  <th className="py-1 pr-2 font-medium">วันที่</th>
                  <th className="py-1 pr-2 font-medium">เข้า–ออก</th>
                  <th className="py-1 pr-2 font-medium text-right">ชม.ทำงาน</th>
                  <th className="py-1 pr-2 font-medium text-right">OT</th>
                  <th className="py-1 font-medium">หมายเหตุ</th>
                </tr>
              </thead>
              <tbody>
                {dayLog.map((d) => {
                  const worked = d.pairs.filter((p) => p.workIn || p.workOut);
                  const first = worked[0];
                  const last = worked[worked.length - 1];
                  const clock = first
                    ? `${first.workIn ?? "—"}–${last?.workOut ?? "—"}`
                    : (d.pairs[0]?.statusLabel ?? "—");
                  const isDouble = d.pairs.some((p) => p.double);
                  const isSpecial = d.pairs.some((p) => p.holiday);
                  const status = d.pairs.find((p) => p.statusLabel)?.statusLabel ?? null;
                  return (
                    <tr key={d.date} className="border-b border-slate-100 last:border-0">
                      <td className="py-1 pr-2 whitespace-nowrap tabular-nums text-slate-600">
                        {d.date.slice(5)}
                      </td>
                      <td className="py-1 pr-2 whitespace-nowrap tabular-nums text-slate-700">
                        {worked.length > 0 ? clock : <span className="text-slate-400">{status ?? "—"}</span>}
                      </td>
                      <td className="py-1 pr-2 text-right tabular-nums text-slate-700">
                        {d.effectiveMinutes > 0 ? fmtMin(d.effectiveMinutes, lang) : "—"}
                      </td>
                      <td className="py-1 pr-2 text-right tabular-nums text-slate-700">
                        {d.otMinutes > 0 ? fmtMin(d.otMinutes, lang) : "—"}
                      </td>
                      <td className="py-1">
                        <span className="flex flex-wrap gap-1">
                          {isDouble && <span className="text-[9px] px-1 py-0.5 rounded bg-rose-100 text-rose-700 font-bold">×2</span>}
                          {isSpecial && !isDouble && <span className="text-[9px] px-1 py-0.5 rounded bg-violet-100 text-violet-700">×1.5</span>}
                          {worked.length > 0 && status && <span className="text-[9px] px-1 py-0.5 rounded bg-slate-100 text-slate-500">{status}</span>}
                          {worked.length > 0 && d.pairs[0]?.branch && <span className="text-[9px] text-slate-400">{d.pairs[0].branch}</span>}
                          {d.edited && <span className="text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700">แก้ไข</span>}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-slate-400 mt-1.5">
            ชั่วโมงทำงานเป็นเวลาหลังหักพักและปรับตามกะ · ×2 = วันจ่ายสองเท่า · ×1.5 = วันพิเศษ (พาร์ทไทม์)
          </p>
        </div>
      )}

      {/* Signature block */}
      <div className="grid grid-cols-2 gap-8 mt-10 text-sm">
        <div>
          <div className="border-b border-slate-400 h-8"></div>
          <div className="text-center mt-1 text-slate-500 text-xs">{t(lang, "admin.persona.payroll.payslip.employeeSignature")}</div>
        </div>
        <div>
          <div className="border-b border-slate-400 h-8"></div>
          <div className="text-center mt-1 text-slate-500 text-xs">{t(lang, "admin.persona.payroll.payslip.dateLabel")}</div>
        </div>
      </div>

      <div className="mt-8 text-center text-[10px] text-slate-400">
        {t(lang, "admin.persona.payroll.payslip.footnote", {
          status: t(lang, `admin.persona.payroll.status.${period.status}` as never)
        })}
      </div>
    </div>
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
      <div className="text-sm font-semibold text-slate-700 border-b border-slate-200 pb-1 mb-1">{title}</div>
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
