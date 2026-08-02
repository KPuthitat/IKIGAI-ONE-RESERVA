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

// The calendar month before `yearMonth` ("2026-07" → "2026-06").
function prevMonth(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
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
  base_pay: number;
  ot_pay: number;
  service_charge: number;
  other_additions: number;
  sso_amount: number;
  tax_amount: number;
  other_deductions: number;
  drink_deductions: number;
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
  const weeks = db.prepare(`
    SELECT pp.id AS period_id, pp.cycle, pp.period_start, pp.period_end,
           pp.pay_date, pp.status, pp.branch_id,
           pl.employment_type, pl.salary_tax_mode_snapshot,
           pl.base_pay, pl.ot_pay, pl.service_charge, pl.other_additions,
           pl.sso_amount, pl.tax_amount, pl.other_deductions, pl.drink_deductions,
           pl.net_pay, pl.days_worked
    FROM payroll_lines pl
    JOIN payroll_periods pp ON pp.id = pl.period_id
    WHERE pl.user_id = ? AND pp.pay_date >= ? AND pp.pay_date <= ?
    ORDER BY pp.period_start, pp.id
  `).all(userId, from, to) as WeekLine[];

  if (weeks.length === 0) notFound();

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
    w.sso_amount || w.tax_amount || w.other_deductions || w.drink_deductions || w.net_pay
  );
  const rows = displayWeeks.length > 0 ? displayWeeks : weeks;

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
  // month's pocket is actually the PREVIOUS month's service charge (owner
  // 2026-08-02: เซอร์วิสชาร์จที่ได้ 20 ก.ค. = ของเดือน มิ.ย. วนแบบนี้ทุกเดือน —
  // this is the true source of "เงินที่ได้รับจริงในเดือนนั้น"). Sum the person's
  // net SVC for that previous month across every branch they belong to.
  const svcMonth = prevMonth(month);
  const svcBranchIds = new Set<number>();
  for (const w of weeks) if (w.branch_id != null) svcBranchIds.add(w.branch_id);
  for (const ub of db.prepare("SELECT branch_id FROM user_branches WHERE user_id = ?").all(userId) as Array<{ branch_id: number }>) {
    svcBranchIds.add(ub.branch_id);
  }
  let svcNetPayout = 0;        // SVC actually received (after WHT + group insurance)
  let svcGroupInsurance = 0;   // group-insurance premium withheld from SVC
  let svcWht = 0;              // WHT withheld from SVC (PT / wht-mode staff only)
  for (const b of svcBranchIds) {
    let summary;
    try { summary = computeMonthlySvcSummary(b, svcMonth); }
    catch { continue; }
    const row = summary.rows.find((r) => r.userId === userId);
    if (row) {
      svcNetPayout += row.netPayout;
      svcGroupInsurance += row.groupInsurance;
      svcWht += row.whtAmount;
    }
  }
  // SVC is shown as income at GROSS (before WHT + group insurance). The WHT (PT
  // only) and the group-insurance premium are then listed as deductions, so the
  // slip shows income → deductions → net cleanly (owner 2026-08-02).
  const svcGross = svcNetPayout + svcWht + svcGroupInsurance;

  // Totals across the displayed lines (empty rows contribute 0, so the sum is
  // unchanged by the filter above).
  const tot = rows.reduce(
    (a, w) => ({
      comp: a.comp + w.base_pay + w.ot_pay,
      other: a.other + w.other_additions + w.service_charge,
      ded: a.ded + w.sso_amount + w.tax_amount + w.other_deductions + w.drink_deductions,
      net: a.net + w.net_pay
    }),
    { comp: 0, other: 0, ded: 0, net: 0 }
  );
  // Plain-language breakdown (owner 2026-08-02): the slip must state income by
  // branch (+OT +SVC) → deductions (WHT/SSO/other) → net. All figures below are
  // just a re-grouping of the same weekly lines — no math changes.
  //   • byBranch: wage income per branch (base + ot + other + in-round SVC)
  //   • dedBreak: each deduction component summed across the month
  //   • netTotal = income − deductions = wages net + SVC net-of-(WHT+insurance)
  // Per-branch ค่าตอบแทน = wage income only (base + OT + other additions). SVC is
  // its OWN income line below, so it's excluded here (owner 2026-08-02). Any
  // legacy in-round SVC (already inside net_pay) is folded into the SVC line via
  // svcInRound so nothing is lost or double-counted.
  const byBranch = new Map<number | null, { income: number; ot: number }>();
  let svcInRound = 0;
  for (const w of rows) {
    const cur = byBranch.get(w.branch_id) ?? { income: 0, ot: 0 };
    cur.income += w.base_pay + w.ot_pay + w.other_additions;
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
  const dedBreak = rows.reduce(
    (a, w) => ({
      sso: a.sso + w.sso_amount,
      tax: a.tax + w.tax_amount,
      drink: a.drink + w.drink_deductions,
      other: a.other + w.other_deductions
    }),
    { sso: 0, tax: 0, drink: 0, other: 0 }
  );
  // SVC income line = the monthly pool (gross) + any legacy in-round SVC.
  const svcIncome = svcGross + svcInRound;
  // tot.other already contains the in-round SVC, so incomeTotal uses svcGross
  // (the monthly pool) once and doesn't double-count svcInRound.
  const incomeTotal = tot.comp + tot.other + svcGross;
  // Deductions grouped per the owner's spec (2026-08-02): FT → ประกันสังคม +
  // ประกันกลุ่ม; PT → ภาษี ณ ที่จ่าย + ประกันกลุ่ม. WHT combines any wage WHT with the
  // SVC WHT; the amounts self-select by employment type (FT has SSO, no WHT; PT
  // has WHT on SVC, no SSO), so we just show whatever is non-zero.
  const whtTotal = dedBreak.tax + svcWht;
  const dedTotal = dedBreak.sso + whtTotal + dedBreak.drink + dedBreak.other + svcGroupInsurance;
  const netTotal = incomeTotal - dedTotal; // = wages net + SVC net-of-(WHT+insurance)

  const first = rows[0];
  const isPt = first.employment_type === "pt";
  const employmentLabel =
    first.employment_type === "pt" ? t(lang, "admin.persona.employees.employment.pt") :
    first.employment_type === "ft" ? t(lang, "admin.persona.employees.employment.ft") :
    "—";
  const isWeekly = weeks.some((w) => w.cycle === "weekly");

  // Non-zero deduction components for a line → "ปกส. ฿x · ภาษี ฿y · …".
  const dedParts = (w: WeekLine): string => {
    const parts: string[] = [];
    if (w.sso_amount > 0) parts.push(`${t(lang, "admin.persona.payroll.col.sso")} ฿${fmtMoney(w.sso_amount)}`);
    if (w.tax_amount > 0) parts.push(`${t(lang, "admin.persona.payroll.col.tax")} ฿${fmtMoney(w.tax_amount)}`);
    if (w.drink_deductions > 0) parts.push(`${t(lang, "admin.persona.payroll.col.drinkDed")} ฿${fmtMoney(w.drink_deductions)}`);
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
        </div>

        {/* Weekly breakdown table */}
        <div className="my-3">
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
                  const other = w.other_additions + w.service_charge;
                  const ded = w.sso_amount + w.tax_amount + w.other_deductions + w.drink_deductions;
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
        </div>

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
              {svcIncome > 0 && (
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-slate-600">
                    เซอร์วิสชาร์จเดือน{monthNameOnly(svcMonth, lang)}{" "}
                    <span className="text-xs text-slate-400">
                      ({isPt ? "ถูกหักภาษี ณ ที่จ่าย" : "ไม่ถูกหักภาษี ณ ที่จ่าย"} · จ่าย ~วันที่ 20 {monthNameOnly(month, lang)})
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
