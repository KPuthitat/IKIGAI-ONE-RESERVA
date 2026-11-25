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
import { buildMonthlyPayslip, type WeekLine } from "@/lib/monthly-payslip";
import { safeFileName, monthTok, token } from "@/lib/download-name";
import PayslipDayLog, { PayslipDayLogLegend } from "@/app/components/PayslipDayLog";
import { apiUrl } from "@/lib/url";

export const dynamic = "force-dynamic";

export function generateMetadata({ params, searchParams }: { params: { userId: string }; searchParams: { m?: string } }): Metadata {
  const userId = Number(params.userId);
  const m = /^\d{4}-\d{2}$/.test(searchParams.m ?? "") ? searchParams.m! : todayMonth();
  const u = Number.isInteger(userId) ? getDb().prepare("SELECT employee_code FROM users WHERE id = ?").get(userId) as { employee_code: string | null } | undefined : undefined;
  return { title: safeFileName(["MonthlyPayslip", token(u?.employee_code, `U${userId}`), monthTok(m)].join("_")) };
}

const TH_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
];
const EN_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

const round2 = (n: number) => Math.round(n * 100) / 100;

function todayMonth(): string {
  const now = new Date();
  const bkk = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return bkk.toISOString().slice(0, 7);
}

function monthLabel(yearMonth: string, lang: Lang): string {
  const [y, m] = yearMonth.split("-").map(Number);
  const months = lang === "th" ? TH_MONTHS : EN_MONTHS;
  const yearDisplay = lang === "th" ? `พ.ศ. ${y + 543}` : String(y);
  return `${months[m - 1]} ${yearDisplay}`;
}

// Month name only (no year) — for the SVC "ของเดือนมิถุนายน" wording.
function monthNameOnly(yearMonth: string, lang: Lang): string {
  const [, m] = yearMonth.split("-").map(Number);
  const months = lang === "th" ? TH_MONTHS : EN_MONTHS;
  return months[m - 1];
}

function maskAccount(acc: string | null): string {
  if (!acc) return "—";
  const digits = acc.replace(/\D/g, "");
  if (digits.length < 8) return acc;
  return `${digits.slice(0, 3)}-x-xxxxx-${digits.slice(-1)}`;
}

export default function MonthlyPayslipPage({
  params,
  searchParams
}: {
  params: { userId: string };
  searchParams: { m?: string };
}) {
  requirePayrollAccess();
  const lang = getLang();
  const db = getDb();

  const userId = Number(params.userId);
  if (!Number.isInteger(userId)) notFound();

  const month = /^\d{4}-\d{2}$/.test(searchParams.m ?? "")
    ? searchParams.m!
    : todayMonth();
  const data = buildMonthlyPayslip(db, userId, month, lang);
  if (!data) notFound();
  const {
    weeks, rows, first, mainBranch, company, headerAddress, profile, svcWht, svcGroupInsurance, meetingFeeGross, dutyFeeGross,
    svcPayLabel, meetingPayLabel, tot, branchIncomeLines, branchNameById, dedBreak, unpaidDays, unpaidCut, svcIncome,
    incomeTotal, whtTotal, dedTotal, netTotal, salarySnap, hourlySnap, dayLogs, empType, employmentLabel, isWeekly, svcMonth
  } = data;

  // Non-zero deduction components for a line → "ปกส. ฿x · ภาษี ฿y · …".
  const dedParts = (w: WeekLine): string => {
    const parts: string[] = [];
    if (w.sso_amount > 0) parts.push(`${t(lang, "admin.persona.payroll.col.sso")} ฿${fmtMoney(w.sso_amount)}`);
    if (w.tax_amount > 0) parts.push(`${t(lang, "admin.persona.payroll.col.tax")} ฿${fmtMoney(w.tax_amount)}`);
    if (w.drink_deductions > 0) parts.push(`${t(lang, "admin.persona.payroll.col.drinkDed")} ฿${fmtMoney(w.drink_deductions)}`);
    if (w.mealpass_deductions > 0) parts.push(`${t(lang, "admin.persona.payroll.col.mealpassDed")} ฿${fmtMoney(w.mealpass_deductions)}`);
    if (w.other_deductions > 0) parts.push(`${t(lang, "admin.persona.payroll.col.otherDed")} ฿${fmtMoney(w.other_deductions)}`);
    if (w.special_paid_out > 0) parts.push(`หักเงินที่จ่ายล่วงหน้าแล้ว ฿${fmtMoney(w.special_paid_out)}`);
    return parts.join(" · ");
  };

  return (
    <>
      {/* On-screen toolbar — hidden when printing */}
      <div className="space-y-3 print:hidden">
        <div className="flex items-center gap-3 flex-wrap">
          <Link href={`/admin/persona/payroll/summary?m=${month}`} className="text-sm text-slate-500 hover:text-brand">
            ← {t(lang, "admin.persona.payroll.backToHub")}
          </Link>
          <Link href={`/admin/persona/payroll/monthly-payslip/${userId}/bank?m=${month}`} className="text-sm font-medium text-brand hover:underline rounded-md border border-brand/40 px-3 py-1 hover:bg-amber-50">
            สลิป A4 สำหรับยื่นภายนอก (ธนาคาร)
          </Link>
          <a href={apiUrl(`/api/admin/persona/payroll/monthly-payslip/${userId}/pdf?m=${month}`)} target="_blank" rel="noopener" className="btn-primary text-sm">ดาวน์โหลด PDF</a>
        </div>
      </div>

      {/* Payslip — visible both on screen and print */}
      <div className="payslip mx-auto bg-white text-slate-800 p-8 max-w-2xl rounded-2xl shadow-card mt-3 print:shadow-none print:rounded-none print:p-6 print:max-w-none">
        {/* Header — company identity + the branch this person is affiliated with */}
        <div className="text-center border-b-2 border-slate-300 pb-3 mb-4">
          <div className="text-2xl font-bold tracking-wide">IKIGAI MEDIHEALTH</div>
          {company?.name_th && (
            <div className="text-sm font-medium text-slate-600 mt-0.5">{company.name_th}</div>
          )}
          {headerAddress && (
            <div className="text-xs text-slate-500 mt-1 whitespace-pre-line">{headerAddress}</div>
          )}
          <div className="text-xs text-slate-500 mt-0.5">
            {company?.tax_id ? `เลขประจำตัวผู้เสียภาษี ${company.tax_id}` : ""}
            {mainBranch?.name ? `${company?.tax_id ? "  ·  " : ""}สาขา ${mainBranch.name}` : ""}
          </div>
          <h1 className="text-xl font-semibold mt-3">
            สลิปค่าตอบแทนรายเดือน · {monthLabel(month, lang)}
          </h1>
        </div>

        {/* Employee info */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm mb-4">
          <Row label={t(lang, "admin.persona.payroll.payslip.employeeName")} value={nameWithPrefix(profile.title_prefix, profile.display_name)} />
          <Row label={t(lang, "admin.persona.payroll.payslip.employeeCode")} value={profile.employee_code ?? "—"} />
          <Row label={t(lang, "admin.persona.payroll.payslip.employmentType")} value={employmentLabel} />
          <Row label="รอบเดือน" value={monthLabel(month, lang)} />
          {/* The rate rule, spelled out (owner 2026-10-01): FT = เงินเดือน ÷ 30 วัน ÷ 8 ชม. */}
          {empType === "ft" && salarySnap != null && (
            <div className="col-span-2 flex flex-wrap gap-x-2 text-xs text-slate-600">
              <span className="text-slate-500">อัตราค่าตอบแทน:</span>
              <span>เงินเดือน ฿{fmtMoney(salarySnap)}</span>
              <span>÷ 30 วัน = <b className="font-medium text-slate-700">฿{fmtMoney(salarySnap / 30)}/วัน</b></span>
              <span>÷ 8 ชม. = <b className="font-medium text-slate-700">฿{fmtMoney(salarySnap / 30 / 8)}/ชม.</b></span>
            </div>
          )}
          {empType === "pt" && hourlySnap != null && (
            <div className="col-span-2 flex flex-wrap gap-x-2 text-xs text-slate-600">
              <span className="text-slate-500">อัตราค่าตอบแทน:</span>
              <span><b className="font-medium text-slate-700">฿{fmtMoney(hourlySnap)}/ชม.</b> × ชั่วโมงทำงานจริง (หลังหักเวลาพัก)</span>
            </div>
          )}
        </div>

        {/* Weekly breakdown table */}
        {rows.length > 0 && <div className="my-3">
          <div className="text-sm font-semibold text-slate-700 border-b border-slate-200 pb-1 mb-2">
            {isWeekly ? "รายละเอียดรายสัปดาห์" : "รายละเอียดรอบจ่าย"}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-200">
                  <th className="py-1.5 pr-2">วันที่</th>
                  <th className="py-1.5 pr-2 text-right whitespace-nowrap">ค่าตอบแทน</th>
                  <th className="py-1.5 pr-2 text-right whitespace-nowrap">รายได้อื่นๆ</th>
                  <th className="py-1.5 pr-2 text-right whitespace-nowrap">รายการหัก</th>
                  <th className="py-1.5 pl-2 text-right whitespace-nowrap">สุทธิ</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => {
                  const comp = w.base_pay + w.ot_pay;
                  const other = round2(w.gross_pay - comp);
                  const ded = w.sso_amount + w.tax_amount + w.other_deductions + w.drink_deductions + w.mealpass_deductions + w.special_paid_out;
                  const parts = dedParts(w);
                  return (
                    <tr key={w.period_id} className="border-b border-slate-100 align-top">
                      <td className="py-1.5 pr-2 whitespace-nowrap">
                        <div className="text-slate-700">
                          {formatLongDate(w.period_start, lang)} – {formatLongDate(w.period_end, lang)}
                        </div>
                        <div className="text-[10px] text-slate-400">
                          จ่าย {formatLongDate(w.pay_date, lang)}
                          {w.days_worked > 0 ? ` · ${w.days_worked} วัน` : ""}
                        </div>
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">
                        {comp ? fmtMoney(comp) : <span className="text-slate-300">—</span>}
                        {w.ot_pay > 0 && (
                          <div className="text-[10px] text-slate-400">รวมโอที ฿{fmtMoney(w.ot_pay)}</div>
                        )}
                        {w.unpaid_leave_days > 0 && w.unpaid_leave_deduction > 0 && (
                          <div className="text-[10px] text-rose-500 whitespace-nowrap">
                            หักลาไม่รับค่าจ้าง {w.unpaid_leave_days} วัน −฿{fmtMoney(w.unpaid_leave_deduction)}
                          </div>
                        )}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">
                        {other ? fmtMoney(other) : <span className="text-slate-300">—</span>}
                        {w.service_charge > 0 && (
                          <div className="text-[10px] text-slate-400">เซอร์วิสชาร์จในรอบ ฿{fmtMoney(w.service_charge)}</div>
                        )}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums text-rose-600">
                        {ded ? fmtMoney(ded) : <span className="text-slate-300">—</span>}
                        {parts && (
                          <div className="text-[10px] text-slate-400 font-normal">{parts}</div>
                        )}
                      </td>
                      <td className="py-1.5 pl-2 text-right tabular-nums font-semibold text-slate-800">
                        {fmtMoney(w.net_pay)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-300 font-semibold text-slate-800">
                  <td className="py-1.5 pr-2">รวมทั้งเดือน</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{fmtMoney(tot.comp)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{fmtMoney(tot.other)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-rose-600">{fmtMoney(tot.ded)}</td>
                  <td className="py-1.5 pl-2 text-right tabular-nums text-emerald-700">{fmtMoney(tot.net)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>}

        {/* Plain-language summary — รายได้ → รายการหัก → สุทธิ */}
        <div className="space-y-3 my-4">
          {/* 1) รายได้ทั้งหมด */}
          <div className="rounded-lg border border-slate-200 overflow-hidden">
            <div className="bg-emerald-50 px-4 py-2 text-sm font-bold text-emerald-800">
              รายได้
            </div>
            <div className="px-4 py-2.5 space-y-1.5 text-sm">
              {branchIncomeLines.map(([bid, v]) => (
                <div key={bid ?? "none"} className="flex items-baseline justify-between gap-3">
                  <span className="text-slate-600">
                    รับจาก{" "}
                    <span className="font-medium text-slate-800">
                      {bid != null ? (branchNameById.get(bid) ?? `สาขา #${bid}`) : "ค่าจ้าง (ไม่ระบุสาขา)"}
                    </span>
                    {v.ot > 0 && (
                      <span className="text-xs text-slate-400"> · รวมโอที ฿{fmtMoney(v.ot)}</span>
                    )}
                  </span>
                  <span className="tabular-nums font-medium text-slate-800">{fmtMoney(v.income)}</span>
                </div>
              ))}
              {unpaidDays > 0 && unpaidCut > 0 && salarySnap != null && (
                <div className="text-xs text-rose-500 -mt-0.5">
                  ค่าตอบแทนข้างต้นหักวันลาไม่รับค่าจ้าง/ขาดงาน {unpaidDays} วันแล้ว −฿{fmtMoney(unpaidCut)}
                  {/* Spell the equation out only when it reproduces the persisted cut
                      exactly (one salary across the rounds, not clamped at the base). */}
                  {round2(salarySnap / 30 * unpaidDays) === unpaidCut && <>{" "}(= เงินเดือน ฿{fmtMoney(salarySnap)} ÷ 30 × {unpaidDays})</>}
                </div>
              )}
              {svcIncome > 0 && (
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-slate-600">
                    เซอร์วิสชาร์จ{meetingFeeGross > 0 ? " + เบี้ยประชุม" : ""}{dutyFeeGross > 0 ? " + ตำแหน่งงานค่าตอบแทนพิเศษ" : ""}เดือน{monthNameOnly(svcMonth, lang)}{" "}
                    <span className="text-xs text-slate-400">
                      ({svcWht > 0 ? "ถูกหักภาษี ณ ที่จ่าย" : "ไม่ถูกหักภาษี ณ ที่จ่าย"} · {svcPayLabel}{meetingPayLabel ? ` · ${meetingPayLabel}` : ""}{meetingFeeGross > 0 ? ` · รวมเบี้ยประชุม ฿${fmtMoney(meetingFeeGross)}` : ""})
                    </span>
                  </span>
                  <span className="tabular-nums font-medium text-violet-700">{fmtMoney(svcIncome)}</span>
                </div>
              )}
              <div className="flex items-baseline justify-between gap-3 border-t border-slate-200 pt-1.5 mt-1.5 font-bold text-slate-800">
                <span>รวมรายได้ทั้งหมด</span>
                <span className="tabular-nums">{fmtMoney(incomeTotal)}</span>
              </div>
            </div>
          </div>

          {/* 2) รายการหักทั้งหมด */}
          <div className="rounded-lg border border-slate-200 overflow-hidden">
            <div className="bg-rose-50 px-4 py-2 text-sm font-bold text-rose-800">
              รายการหัก
            </div>
            <div className="px-4 py-2.5 space-y-1.5 text-sm">
              {/* FT → ประกันสังคม; PT → ภาษี ณ ที่จ่าย. Zero rows hide, so each
                  employment type shows only its own deductions (owner 2026-08-02). */}
              {dedBreak.sso > 0 && (
                <DedRow label={t(lang, "admin.persona.payroll.col.sso")} value={dedBreak.sso} />
              )}
              {whtTotal > 0 && (
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-slate-600">
                    {t(lang, "admin.persona.payroll.col.tax")}{" "}
                    {svcWht > 0 && (
                      <span className="text-xs text-slate-400">(หักจากเซอร์วิสชาร์จ)</span>
                    )}
                  </span>
                  <span className="tabular-nums font-medium text-slate-700">{fmtMoney(whtTotal)}</span>
                </div>
              )}
              {dedBreak.drink > 0 && (
                <DedRow label={t(lang, "admin.persona.payroll.col.drinkDed")} value={dedBreak.drink} />
              )}
              {dedBreak.mealpass > 0 && (
                <DedRow label={t(lang, "admin.persona.payroll.col.mealpassDed")} value={dedBreak.mealpass} />
              )}
              {dedBreak.other > 0 && (
                <DedRow label={t(lang, "admin.persona.payroll.col.otherDed")} value={dedBreak.other} />
              )}
              {svcGroupInsurance > 0 && (
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-slate-600">
                    ประกันกลุ่ม{" "}
                    <span className="text-xs text-slate-400">(หักจากเซอร์วิสชาร์จ)</span>
                  </span>
                  <span className="tabular-nums font-medium text-slate-700">{fmtMoney(svcGroupInsurance)}</span>
                </div>
              )}
              {dedTotal === 0 && (
                <div className="text-sm text-slate-400 italic">{t(lang, "admin.persona.payroll.payslip.noDeductions")}</div>
              )}
              <div className="flex items-baseline justify-between gap-3 border-t border-slate-200 pt-1.5 mt-1.5 font-bold text-slate-800">
                <span>รวมรายการหัก</span>
                <span className="tabular-nums text-rose-600">{fmtMoney(dedTotal)}</span>
              </div>
            </div>
          </div>

          {/* 3) สรุป: ได้ก่อนหัก → หัก → สุทธิ (owner 2026-08-02: ต้องเห็นชัดว่าก่อน
              หักพนักงานได้เท่าไหร่) */}
          <div className="border-2 border-slate-800 rounded-lg p-4 bg-slate-50 space-y-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-semibold text-slate-700">รายได้ก่อนหัก (รวมรายรับทั้งหมด)</span>
              <span className="text-lg font-bold text-slate-800 whitespace-nowrap tabular-nums">
                {fmtMoney(incomeTotal)} <span className="text-xs font-normal">บาท</span>
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-slate-600">รวมรายการหัก</span>
              <span className="text-base font-semibold text-rose-600 whitespace-nowrap tabular-nums">
                − {fmtMoney(dedTotal)} <span className="text-xs font-normal">บาท</span>
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-3 border-t-2 border-slate-300 pt-1.5 mt-1.5">
              <span className="text-base font-bold">รายได้สุทธิ (รับจริง)</span>
              <span className="text-2xl font-bold text-emerald-700 whitespace-nowrap tabular-nums">
                {fmtMoney(netTotal)} <span className="text-sm font-normal">บาท</span>
              </span>
            </div>
            {profile.bank_name && profile.bank_account && (
              <div className="text-xs text-slate-600 mt-2 border-t border-slate-300 pt-2">
                {t(lang, "admin.persona.payroll.payslip.transferTo")}:{" "}
                <span className="font-medium">{profile.bank_name}</span>{" "}
                {maskAccount(profile.bank_account)}
              </div>
            )}
          </div>
        </div>

        {/* Daily calculation — one table per pay round, the SAME per-day
            breakdown the per-round slip shows (owner 2026-10-01: พนักงานต้องเห็น
            วิธีการคำนวณรายวัน). */}
        {dayLogs.length > 0 && (
          <div className="my-4 break-inside-avoid">
            <div className="text-sm font-semibold text-slate-700 border-b border-slate-200 pb-1 mb-1">
              รายละเอียดการคำนวณรายวัน
            </div>
            <div className="text-[11px] text-slate-500 mb-2">
              {empType === "ft" && salarySnap != null
                ? <>ค่าตอบแทนประจำคิดจากเงินเดือน ฿{fmtMoney(salarySnap)} ÷ 30 วัน = ฿{fmtMoney(salarySnap / 30)}/วัน · ค่าล่วงเวลาและวันจ่ายสองเท่าคิดจาก ฿{fmtMoney(salarySnap / 30 / 8)}/ชม. · วันลาไม่รับค่าจ้าง/ขาดงานหักวันละ ฿{fmtMoney(salarySnap / 30)}</>
                : empType === "pt" && hourlySnap != null
                  ? <>ค่าตอบแทนรายวัน = ชั่วโมงทำงานจริง (หลังหักเวลาพัก) × ฿{fmtMoney(hourlySnap)}/ชม. · ค่าล่วงเวลาและวันพิเศษคิดเพิ่มตามอัตราที่กำหนด</>
                  : <>ชั่วโมงทำงานหลังหักเวลาพักและปรับตามกะ พร้อมค่าล่วงเวลาของแต่ละวัน</>}
            </div>
            {dayLogs.map(({ w, days, ftMonthly }) => (
              <PayslipDayLog
                key={w.period_id}
                lang={lang}
                dayLog={days}
                isAdmin
                compact
                showDayPay={!ftMonthly}
                title={`งวด ${formatLongDate(w.period_start, lang)} – ${formatLongDate(w.period_end, lang)} · จ่าย ${formatLongDate(w.pay_date, lang)}`}
              />
            ))}
            <PayslipDayLogLegend showDayPay={dayLogs.some((x) => !x.ftMonthly)} />
          </div>
        )}

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
      </div>
    </>
  );
}

// ── Helper components ────────────────────────────────────────────────

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex">
      <span className="text-slate-500 mr-2 whitespace-nowrap">{label}:</span>
      <span className="font-medium text-slate-700">{value}</span>
    </div>
  );
}

// One line in the "รายการหัก" section — label left, amount right ("—" when 0).
function DedRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-slate-600">{label}</span>
      <span className="tabular-nums font-medium text-slate-700">
        {value > 0 ? fmtMoney(value) : <span className="text-slate-300">—</span>}
      </span>
    </div>
  );
}
