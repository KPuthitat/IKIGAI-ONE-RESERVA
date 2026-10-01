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
import { companySvcPayoutState, computePayoutDate, getSvcBatch, svcBatchPayDates, type SvcPayDates } from "@/lib/service-charge";
import { monthlyPayrollRollup } from "@/lib/payroll-month";
import { buildLineBreakdown } from "@/lib/payroll-breakdown";
import PayslipDayLog, { PayslipDayLogLegend } from "@/app/components/PayslipDayLog";
import PayslipPrintButton from "../../[id]/payslip/[userId]/PayslipPrintButton";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "สลิปค่าตอบแทนรายเดือน · PERSONA" };

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

function monthRange(yearMonth: string): { from: string; to: string } {
  const [y, m] = yearMonth.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    from: `${yearMonth}-01`,
    to: `${yearMonth}-${String(lastDay).padStart(2, "0")}`
  };
}

function monthLabel(yearMonth: string, lang: Lang): string {
  const [y, m] = yearMonth.split("-").map(Number);
  const months = lang === "th" ? TH_MONTHS : EN_MONTHS;
  const yearDisplay = lang === "th" ? y + 543 : y;
  return `${months[m - 1]} ${yearDisplay}`;
}

// Month name only (no year) — for the SVC "ของเดือนมิถุนายน" wording.
function monthNameOnly(yearMonth: string, lang: Lang): string {
  const [, m] = yearMonth.split("-").map(Number);
  const months = lang === "th" ? TH_MONTHS : EN_MONTHS;
  return months[m - 1];
}

// One weekly (or monthly) payroll line the employee had in the calendar month,
// with its parent period's dates. Ordered by period_start.
type WeekLine = {
  period_id: number;
  cycle: "weekly" | "monthly";
  period_start: string;
  period_end: string;
  pay_date: string;
  status: "draft" | "finalized" | "paid" | "cancelled";
  branch_id: number | null;
  employment_type: "pt" | "ft" | null;
  salary_tax_mode_snapshot: "sso" | "wht" | null;
  monthly_salary_snapshot: number | null;
  hourly_rate_snapshot: number | null;
  unpaid_leave_days: number;
  unpaid_leave_deduction: number;   // engine's persisted cut (FT only; salary ÷ 30 × days)
  base_pay: number;
  ot_pay: number;
  service_charge: number;
  other_additions: number;
  meeting_fee: number;              // legacy in-round meeting fee (rides in gross_pay)
  gross_pay: number;
  sso_amount: number;
  tax_amount: number;
  other_deductions: number;
  drink_deductions: number;
  mealpass_deductions: number;
  net_pay: number;
  days_worked: number;
};

type EmployeeProfile = {
  display_name: string;
  bank_name: string | null;
  bank_account: string | null;
  employee_code: string | null;
  title_prefix: string | null;
};

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
  const { from, to } = monthRange(month);

  // Every payroll line this person had in the month — one per weekly (or the
  // single monthly) period whose pay_date lands in the month. Same month rule
  // as the summary page (pay_date ∈ [from,to]), so the two always agree.
  // Branch-stamped periods only — the same scope as monthlyPayrollRollup, so the
  // lines listed here add up to exactly the rollup's ค่าตอบแทน.
  const weeks = db.prepare(`
    SELECT pp.id AS period_id, pp.cycle, pp.period_start, pp.period_end,
           pp.pay_date, pp.status, pp.branch_id,
           pl.employment_type, pl.salary_tax_mode_snapshot,
           pl.monthly_salary_snapshot, pl.hourly_rate_snapshot,
           pl.unpaid_leave_days, pl.unpaid_leave_deduction,
           pl.base_pay, pl.ot_pay, pl.service_charge, pl.other_additions, pl.meeting_fee, pl.gross_pay,
           pl.sso_amount, pl.tax_amount, pl.other_deductions, pl.drink_deductions, pl.mealpass_deductions,
           pl.net_pay, pl.days_worked
    FROM payroll_lines pl
    JOIN payroll_periods pp ON pp.id = pl.period_id
    WHERE pl.user_id = ? AND pp.pay_date >= ? AND pp.pay_date <= ? AND pp.branch_id IS NOT NULL
    ORDER BY pp.period_start, pp.id
  `).all(userId, from, to) as WeekLine[];

  // ── ONE data set (owner 2026-10-01) ──────────────────────────────────
  // Every money figure on this slip comes from monthlyPayrollRollup — the same
  // rollup the summary page and the export document read — so the employee's
  // slip can never disagree with the books. `mine` = this person's row in each
  // company they were paid by this month (payroll, SVC and/or meeting fee).
  const rollup = monthlyPayrollRollup(db, month);
  const mine = rollup.people.filter((p) => p.userId === userId);
  if (weeks.length === 0 && mine.length === 0) notFound();

  const profile = db.prepare(
    "SELECT display_name, bank_name, bank_account, employee_code, title_prefix FROM users WHERE id = ?"
  ).get(userId) as EmployeeProfile | undefined;
  if (!profile) notFound();

  // Only pay rounds where money actually moved (owner 2026-08-02: "รอบไหนไม่มี
  // การรับเงิน ไม่ต้องพูดถึง"). Empty duplicate period rows — everything zero —
  // just add noise to a weekly payslip, so drop them. Fall back to the raw list
  // if that would leave nothing (shouldn't happen — weeks.length was checked).
  const displayWeeks = weeks.filter((w) =>
    w.base_pay || w.ot_pay || w.service_charge || w.other_additions ||
    w.sso_amount || w.tax_amount || w.other_deductions || w.drink_deductions || w.mealpass_deductions || w.net_pay
  );
  const rows = displayWeeks.length > 0 ? displayWeeks : weeks;
  const first: WeekLine | undefined = rows[0];

  // Header identity — the company that pays this person and the branch they're
  // primarily affiliated with (owner 2026-08-02: หัวกระดาษต้องเป็นที่อยู่บริษัท
  // และสาขาที่สังกัดหลัก). Main branch = the branch appearing most across this
  // month's payroll lines; fall back to their first user_branches row.
  const branchTally = new Map<number, number>();
  for (const w of rows) if (w.branch_id != null) branchTally.set(w.branch_id, (branchTally.get(w.branch_id) ?? 0) + 1);
  let mainBranchId: number | null = branchTally.size
    ? [...branchTally.entries()].sort((a, b) => b[1] - a[1])[0][0]
    : null;
  if (mainBranchId == null) {
    mainBranchId = (db.prepare(
      "SELECT branch_id FROM user_branches WHERE user_id = ? ORDER BY branch_id LIMIT 1"
    ).get(userId) as { branch_id: number } | undefined)?.branch_id ?? null;
  }
  const mainBranch = mainBranchId
    ? (db.prepare("SELECT id, name, company_id, reg_address FROM branches WHERE id = ?")
        .get(mainBranchId) as { id: number; name: string; company_id: number | null; reg_address: string | null } | undefined)
    : undefined;
  const company = mainBranch?.company_id
    ? (db.prepare("SELECT name_th, tax_id, address, phone FROM companies WHERE id = ?")
        .get(mainBranch.company_id) as { name_th: string; tax_id: string | null; address: string | null; phone: string | null } | undefined)
    : undefined;
  const headerAddress = company?.address ?? mainBranch?.reg_address ?? null;

  // Service charge received THIS month — a SEPARATE monthly payout
  // (svc_payout_batches), not inside any weekly net_pay. SVC for a month is
  // paid on ~the 20th of the FOLLOWING month, so the money landing in this
  // month's pocket is the PREVIOUS month's service charge (owner 2026-08-02).
  // The figures are the rollup's (company roll-up authority + เบี้ยประชุม with its
  // per-meeting branch override), summed over every company that paid this person.
  const svcMonth = rollup.svcMonth;
  const sum = (f: (p: (typeof mine)[number]) => number) => round2(mine.reduce((a, p) => a + f(p), 0));
  const svcGrossOnly = sum((p) => p.svcGross);
  const svcWht = sum((p) => p.svcWht + p.mtgWht);     // WHT on SVC + meeting fee (wht-mode staff)
  const svcGroupInsurance = sum((p) => p.svcGi);
  const meetingFeeGross = sum((p) => p.mtgGross);
  // SVC is shown as income at GROSS (before WHT + group insurance); the WHT and the
  // premium are then listed as deductions (owner 2026-08-02). Includes เบี้ยประชุม.
  const svcGross = round2(svcGrossOnly + meetingFeeGross);

  // Actual transfer dates (owner 2026-10-01: "เอาวันโอนจริง") — read from the SVC
  // batch of each paying company; before a batch exists the default 20th shows as
  // "กำหนดโอน". The meeting fee carries its own date when it was transferred later.
  type PayInfo = { dates: SvcPayDates; paid: boolean };
  const payInfos: PayInfo[] = [];
  const seenPayCo = new Set<string>();
  for (const p of mine) {
    if (!(p.svcGross > 0 || p.mtgGross > 0)) continue;
    const coKey = String(p.companyId);
    if (seenPayCo.has(coKey)) continue;
    seenPayCo.add(coKey);
    if (p.companyId != null) {
      try {
        const st = companySvcPayoutState(p.companyId, svcMonth);
        if (st.payDates) payInfos.push({ dates: st.payDates, paid: st.status === "paid" || st.status === "posted" });
      } catch { /* no payout state */ }
    } else {
      // Pre-migration NULL-company branches only — never another company's batch.
      for (const ub of db.prepare(`
        SELECT ub.branch_id FROM user_branches ub JOIN branches b ON b.id = ub.branch_id
        WHERE ub.user_id = ? AND b.company_id IS NULL ORDER BY ub.branch_id
      `).all(userId) as Array<{ branch_id: number }>) {
        const batch = getSvcBatch(ub.branch_id, svcMonth);
        if (batch) { payInfos.push({ dates: svcBatchPayDates(batch.id), paid: batch.status === "paid" || batch.status === "posted" }); break; }
      }
    }
  }
  const payInfo = payInfos[0] ?? null;
  // "โอนแล้ว" only once the batch is paid AND the date has arrived — a batch paid
  // today with a meeting-fee date next week is still "กำหนดโอน" for that part.
  const todayIso = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const paidWord = (date: string) => (payInfo?.paid && date <= todayIso ? "โอนแล้ว" : "กำหนดโอน");
  const svcPayLabel = payInfo
    ? `${paidWord(payInfo.dates.svcPayDate)} ${formatLongDate(payInfo.dates.svcPayDate, lang)}`
    : `กำหนดโอน ${formatLongDate(computePayoutDate(svcMonth), lang)}`;
  const meetingPayLabel = payInfo && meetingFeeGross > 0 && payInfo.dates.meetingPayDate !== payInfo.dates.svcPayDate
    ? `เบี้ยประชุม${paidWord(payInfo.dates.meetingPayDate)} ${formatLongDate(payInfo.dates.meetingPayDate, lang)}`
    : null;

  // Totals of the listed lines — the detail table ties out to the rollup's
  // ค่าตอบแทน (gross) and stored net.
  const tot = rows.reduce(
    (a, w) => ({
      comp: a.comp + w.base_pay + w.ot_pay,
      other: a.other + (w.gross_pay - w.base_pay - w.ot_pay),
      ded: a.ded + w.sso_amount + w.tax_amount + w.other_deductions + w.drink_deductions + w.mealpass_deductions,
      net: a.net + w.net_pay
    }),
    { comp: 0, other: 0, ded: 0, net: 0 }
  );
  // Plain-language breakdown (owner 2026-08-02): income by branch (+OT) → SVC →
  // deductions (SSO/WHT/other) → net. Per-branch ค่าตอบแทน = everything in the
  // round's gross except in-round SVC (which folds into the SVC line via svcInRound).
  const byBranch = new Map<number | null, { income: number; ot: number }>();
  let svcInRound = 0;
  for (const w of rows) {
    const cur = byBranch.get(w.branch_id) ?? { income: 0, ot: 0 };
    cur.income += w.gross_pay - w.service_charge;
    cur.ot += w.ot_pay;
    byBranch.set(w.branch_id, cur);
    svcInRound += w.service_charge;
  }
  const branchIncomeLines = [...byBranch.entries()]
    .filter(([, v]) => v.income !== 0)
    .sort((a, b) => b[1].income - a[1].income);
  const branchNameById = new Map<number, string>();
  for (const b of db.prepare("SELECT id, name FROM branches").all() as Array<{ id: number; name: string }>) {
    branchNameById.set(b.id, b.name);
  }
  // Deductions straight from the rollup (stored-net anchored; itemised parts capped).
  const dedBreak = {
    sso: sum((p) => p.sso),
    tax: sum((p) => p.taxWage),
    drink: sum((p) => p.drink),
    mealpass: sum((p) => p.mealpass),
    other: sum((p) => p.otherDed)
  };
  const unpaidDays = sum((p) => p.unpaidDays);
  const unpaidCut = sum((p) => p.unpaidCut);   // the engine's persisted figure (capped at the base)
  // SVC income line = the monthly pool (gross, incl. เบี้ยประชุม) + any legacy in-round SVC.
  const svcIncome = round2(svcGross + svcInRound);
  // The three headline figures ARE the rollup's: income − deductions = take.
  const incomeTotal = sum((p) => p.income);
  const whtTotal = sum((p) => p.tax);           // wage WHT + SVC WHT + meeting-fee WHT
  const dedTotal = sum((p) => p.ded);
  const netTotal = sum((p) => p.take);

  // Rates (owner 2026-10-01: "เงินเดือนต่อวัน ต่อชม. ก็ต้องหารด้วย 30 วัน 8 ชั่วโมง") —
  // the slip spells the rule out so the employee can check every daily figure.
  const salarySnap = rows.reduce<number | null>((a, w) => (w.monthly_salary_snapshot != null && w.monthly_salary_snapshot > 0 ? Math.max(a ?? 0, w.monthly_salary_snapshot) : a), null);
  const hourlySnap = rows.reduce<number | null>((a, w) => (w.hourly_rate_snapshot != null && w.hourly_rate_snapshot > 0 ? Math.max(a ?? 0, w.hourly_rate_snapshot) : a), null);

  // Daily calculation per pay round — the SAME breakdown the per-round slip and
  // the admin modal show (buildLineBreakdown), so the evidence is one set too.
  const dayLogs = rows.map((w) => {
    const b = buildLineBreakdown(db, w.period_id, userId);
    return { w, days: b?.days ?? [], ftMonthly: b?.ftMonthly ?? false, doublePremium: b?.doublePremium ?? 0 };
  }).filter((x) => x.days.length > 0);

  const empType = first?.employment_type ?? mine[0]?.employmentType ?? null;
  const isPt = empType === "pt";
  const employmentLabel =
    empType === "pt" ? t(lang, "admin.persona.employees.employment.pt") :
    empType === "ft" ? t(lang, "admin.persona.employees.employment.ft") :
    "—";
  const isWeekly = weeks.some((w) => w.cycle === "weekly");

  // Non-zero deduction components for a line → "ปกส. ฿x · ภาษี ฿y · …".
  const dedParts = (w: WeekLine): string => {
    const parts: string[] = [];
    if (w.sso_amount > 0) parts.push(`${t(lang, "admin.persona.payroll.col.sso")} ฿${fmtMoney(w.sso_amount)}`);
    if (w.tax_amount > 0) parts.push(`${t(lang, "admin.persona.payroll.col.tax")} ฿${fmtMoney(w.tax_amount)}`);
    if (w.drink_deductions > 0) parts.push(`${t(lang, "admin.persona.payroll.col.drinkDed")} ฿${fmtMoney(w.drink_deductions)}`);
    if (w.mealpass_deductions > 0) parts.push(`${t(lang, "admin.persona.payroll.col.mealpassDed")} ฿${fmtMoney(w.mealpass_deductions)}`);
    if (w.other_deductions > 0) parts.push(`${t(lang, "admin.persona.payroll.col.otherDed")} ฿${fmtMoney(w.other_deductions)}`);
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
          <PayslipPrintButton lang={lang} />
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
                  const ded = w.sso_amount + w.tax_amount + w.other_deductions + w.drink_deductions + w.mealpass_deductions;
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
                    เซอร์วิสชาร์จ{meetingFeeGross > 0 ? " + เบี้ยประชุม" : ""}เดือน{monthNameOnly(svcMonth, lang)}{" "}
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
