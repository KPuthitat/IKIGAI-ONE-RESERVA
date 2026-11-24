// Monthly payslip data (one person, one calendar month) — shared by the page and the PDF so both show identical
// numbers. Every money figure comes from monthlyPayrollRollup (the same rollup the summary page + export read).
import type Database from "better-sqlite3";
import { t, type Lang } from "@/lib/i18n";
import { formatLongDate } from "@/lib/time";
import { companySvcPayoutState, computePayoutDate, getSvcBatch, svcBatchPayDates, type SvcPayDates } from "@/lib/service-charge";
import { monthlyPayrollRollup } from "@/lib/payroll-month";
import { buildLineBreakdown } from "@/lib/payroll-breakdown";

export const round2 = (n: number) => Math.round(n * 100) / 100;

export function monthRange(yearMonth: string): { from: string; to: string } {
  const [y, m] = yearMonth.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    from: `${yearMonth}-01`,
    to: `${yearMonth}-${String(lastDay).padStart(2, "0")}`
  };
}

// One weekly (or monthly) payroll line the employee had in the calendar month,
// with its parent period's dates. Ordered by period_start.
export type WeekLine = {
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
  special_paid_out: number;         // เงินช่วยเหลือพิเศษ/เบิกล่วงหน้า ที่จ่ายไปแล้ว (หักจากยอดโอน)
  net_pay: number;
  days_worked: number;
};

export type EmployeeProfile = {
  display_name: string;
  bank_name: string | null;
  bank_account: string | null;
  employee_code: string | null;
  title_prefix: string | null;
};


export function buildMonthlyPayslip(db: Database.Database, userId: number, month: string, lang: Lang) {
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
           pl.sso_amount, pl.tax_amount, pl.other_deductions, pl.drink_deductions, pl.mealpass_deductions, pl.special_paid_out,
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
  if (weeks.length === 0 && mine.length === 0) return null;

  const profile = db.prepare(
    "SELECT display_name, bank_name, bank_account, employee_code, title_prefix FROM users WHERE id = ?"
  ).get(userId) as EmployeeProfile | undefined;
  if (!profile) return null;

  // Only pay rounds where money actually moved (owner 2026-08-02: "รอบไหนไม่มี
  // การรับเงิน ไม่ต้องพูดถึง"). Empty duplicate period rows — everything zero —
  // just add noise to a weekly payslip, so drop them. Fall back to the raw list
  // if that would leave nothing (shouldn't happen — weeks.length was checked).
  const displayWeeks = weeks.filter((w) =>
    w.base_pay || w.ot_pay || w.service_charge || w.other_additions ||
    w.sso_amount || w.tax_amount || w.other_deductions || w.drink_deductions || w.mealpass_deductions || w.special_paid_out || w.net_pay
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
  const svcWht = sum((p) => p.svcWht + p.mtgWht + p.dutyWht);     // WHT on SVC + meeting fee + duty fee (wht-mode staff)
  const svcGroupInsurance = sum((p) => p.svcGi);
  const meetingFeeGross = sum((p) => p.mtgGross);
  const dutyFeeGross = sum((p) => p.dutyGross);   // ตำแหน่งงานค่าตอบแทนพิเศษ (owner 2026-10-11)
  // SVC is shown as income at GROSS (before WHT + group insurance); the WHT and the
  // premium are then listed as deductions (owner 2026-08-02). Includes เบี้ยประชุม.
  const svcGross = round2(svcGrossOnly + meetingFeeGross + dutyFeeGross);

  // Actual transfer dates (owner 2026-10-01: "เอาวันโอนจริง") — read from the SVC
  // batch of each paying company; before a batch exists the default 20th shows as
  // "กำหนดโอน". The meeting fee carries its own date when it was transferred later.
  type PayInfo = { dates: SvcPayDates; paid: boolean };
  const payInfos: PayInfo[] = [];
  const seenPayCo = new Set<string>();
  for (const p of mine) {
    if (!(p.svcGross > 0 || p.mtgGross > 0 || p.dutyGross > 0)) continue;
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
      ded: a.ded + w.sso_amount + w.tax_amount + w.other_deductions + w.drink_deductions + w.mealpass_deductions + w.special_paid_out,
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
  return {
    weeks, rows, first, mainBranch, company, headerAddress, profile, svcMonth, svcWht, svcGroupInsurance, meetingFeeGross, dutyFeeGross,
    svcGross, svcPayLabel, meetingPayLabel, tot, branchIncomeLines, branchNameById, dedBreak, unpaidDays, unpaidCut, svcIncome,
    incomeTotal, whtTotal, dedTotal, netTotal, salarySnap, hourlySnap, dayLogs, empType, isPt, employmentLabel, isWeekly
  };
}
export type MonthlyPayslip = NonNullable<ReturnType<typeof buildMonthlyPayslip>>;
