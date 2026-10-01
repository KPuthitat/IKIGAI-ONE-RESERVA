import Link from "next/link";
import type { Metadata } from "next";
import { requirePayrollAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t, type Lang } from "@/lib/i18n";
import { formatLongDate } from "@/lib/time";
import { fmtMoney } from "@/lib/format";
import { nameWithPrefix } from "@/lib/name";
import { computeMonthlySvcSummary, computeCompanySvcSummary, meetingFeeByUserCompany } from "@/lib/service-charge";
import { listExportScopes } from "@/lib/payroll-summary-doc";
import ExportDialog from "./ExportDialog";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "สรุปประจำเดือน · ค่าตอบแทน" };

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

function shiftMonth(yearMonth: string, delta: number): string {
  const [y, m] = yearMonth.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

function monthLabel(yearMonth: string, lang: Lang): string {
  const [y, m] = yearMonth.split("-").map(Number);
  const months = lang === "th" ? TH_MONTHS : EN_MONTHS;
  const yearDisplay = lang === "th" ? y + 543 : y;
  return `${months[m - 1]} ${yearDisplay}`;
}

// fmtMoney moved to @/lib/format (2026-05) — imported above so every
// payroll surface shares an identical 2dp shape.

// Per-employee aggregate row across all periods that pay in the month
type EmpRow = {
  user_id: number;
  display_name: string;
  title_prefix: string | null;
  employment_type: "pt" | "ft" | null;
  salary_tax_mode_snapshot: "sso" | "wht" | null;
  total_gross: number;
  total_sso: number;
  total_tax: number;
  total_net: number;
  period_count: number;
  // In-round deductions (owner 2026-10-01: "ระหว่างเดือนมีใครถูกหักอะไร ลงให้ครบ").
  total_drink: number;        // ค่าเครื่องดื่ม (จ้อจี้)
  total_mealpass: number;     // ค่าอาหารข้ามบริษัท (ศาลาชิลล์)
  total_unpaid_days: number;  // FT only: ลาไม่รับค่าจ้าง + ขาดงาน (วัน) — PT days never cut pay
  total_base_cut: number;     // FT only: salary cut for those days (mirrors unpaidLeaveDeduction) — ฐานประกันสังคมจึงต่ำกว่าเงินเดือน
};

// Per-period aggregate (header summary of each period)
type PeriodRow = {
  id: number;
  cycle: "weekly" | "monthly";
  target: "pt" | "ft" | "all";
  period_start: string;
  period_end: string;
  pay_date: string;
  status: "draft" | "finalized" | "paid" | "cancelled";
  total_gross: number | null;
  total_sso: number | null;
  total_tax: number | null;
  total_net: number | null;
  line_count: number;
};

export default function PayrollMonthlySummaryPage({
  searchParams
}: {
  searchParams: { m?: string };
}) {
  requirePayrollAccess();
  const lang = getLang();
  const db = getDb();

  const month = /^\d{4}-\d{2}$/.test(searchParams.m ?? "")
    ? searchParams.m!
    : todayMonth();
  const { from, to } = monthRange(month);

  // All periods whose pay_date falls in this month
  const periods = db.prepare(`
    SELECT p.id, p.cycle, p.target, p.period_start, p.period_end, p.pay_date, p.status,
           (SELECT SUM(gross_pay)  FROM payroll_lines WHERE period_id = p.id) AS total_gross,
           (SELECT SUM(sso_amount) FROM payroll_lines WHERE period_id = p.id) AS total_sso,
           (SELECT SUM(tax_amount) FROM payroll_lines WHERE period_id = p.id) AS total_tax,
           (SELECT SUM(net_pay)    FROM payroll_lines WHERE period_id = p.id) AS total_net,
           (SELECT COUNT(*)        FROM payroll_lines WHERE period_id = p.id) AS line_count
    FROM payroll_periods p
    WHERE p.pay_date >= ? AND p.pay_date <= ?
    ORDER BY p.pay_date, p.id
  `).all(from, to) as PeriodRow[];

  // Per-employee aggregate across all those periods
  const empRows = db.prepare(`
    SELECT pl.user_id,
           pl.display_name,
           u.title_prefix,
           MAX(pl.employment_type) AS employment_type,
           MAX(pl.salary_tax_mode_snapshot) AS salary_tax_mode_snapshot,
           SUM(pl.gross_pay)  AS total_gross,
           SUM(pl.sso_amount) AS total_sso,
           SUM(pl.tax_amount) AS total_tax,
           SUM(pl.net_pay)    AS total_net,
           COUNT(*)            AS period_count,
           SUM(pl.drink_deductions)    AS total_drink,
           SUM(pl.mealpass_deductions) AS total_mealpass,
           -- FT only (a PT's unpaid day is simply no shift = no pay). The cut mirrors
           -- unpaidLeaveDeduction(): salary/30 per day, rounded — exact in every
           -- non-clamped case (prorated bases included); capped at the salary.
           SUM(CASE WHEN pl.employment_type = 'ft' THEN pl.unpaid_leave_days ELSE 0 END) AS total_unpaid_days,
           SUM(CASE WHEN pl.employment_type = 'ft' AND pl.unpaid_leave_days > 0 AND pl.monthly_salary_snapshot > 0
                    THEN MIN(ROUND(pl.monthly_salary_snapshot / 30.0 * pl.unpaid_leave_days, 2), pl.monthly_salary_snapshot)
                    ELSE 0 END) AS total_base_cut
    FROM payroll_lines pl
    JOIN payroll_periods pp ON pl.period_id = pp.id
    LEFT JOIN users u ON u.id = pl.user_id
    WHERE pp.pay_date >= ? AND pp.pay_date <= ?
    GROUP BY pl.user_id
    ORDER BY (MAX(pl.employment_type) = 'ft') DESC,
             (MAX(pl.employment_type) = 'pt') DESC,
             pl.display_name
  `).all(from, to) as EmpRow[];

  // Per-branch GROSS columns were removed (owner 2026-09-03: "ยุบให้เรียบ") — the
  // company sectioning + the สังกัด column already carry the branch split at
  // overview altitude; the granular NAMA-vs-HYPO-per-person amounts live on the
  // per-branch payroll pages, not this month-total overview.

  // สังกัด (home branch) per user — is_primary=1, else lowest branch_id.
  const homeRows = db.prepare(`
    SELECT ub.user_id,
           COALESCE(
             (SELECT branch_id FROM user_branches WHERE user_id = ub.user_id AND is_primary = 1 LIMIT 1),
             (SELECT MIN(branch_id) FROM user_branches WHERE user_id = ub.user_id)
           ) AS home_branch_id,
           (SELECT name FROM branches WHERE id = (
             SELECT COALESCE(
               (SELECT branch_id FROM user_branches WHERE user_id = ub.user_id AND is_primary = 1 LIMIT 1),
               (SELECT MIN(branch_id) FROM user_branches WHERE user_id = ub.user_id)
             ))) AS home_branch_name
    FROM (SELECT DISTINCT user_id FROM user_branches) ub
  `).all() as Array<{ user_id: number; home_branch_id: number | null; home_branch_name: string | null }>;
  const homeByUser = new Map<number, string | null>();
  for (const r of homeRows) homeByUser.set(r.user_id, r.home_branch_name);

  // ── Group by COMPANY (owner 2026-08-01) ──────────────────────────────
  // The books are separate per company (e.g. NAMA+HYPO = one company, AT HOME =
  // another), so the summary must not mix them. Each branch belongs to a
  // company; we render a section per company and aggregate each person's pay PER
  // COMPANY so each company's section ties out to its own books.
  //
  // The set of branches to include is the UNION of (payroll periods paying this
  // month) ∪ (service-charge activity in svcMonth) — owner 2026-09-03: anyone who
  // received money from a company that had transactions must appear, or the tax
  // docs (ใบหัก ณ ที่จ่าย) miss people (e.g. ศาลาชิลล์ staff who only get service
  // charge, or a company with no payroll round paying this month but SVC to pay).
  const svcMonth = shiftMonth(month, -1);
  type BranchRow = { branch_id: number; branch_name: string; company_id: number | null; company_name: string | null };
  const payrollBranches = db.prepare(`
    SELECT b.id AS branch_id, b.name AS branch_name, b.company_id AS company_id, c.name_th AS company_name
    FROM payroll_periods pp
    JOIN branches b ON b.id = pp.branch_id
    LEFT JOIN companies c ON c.id = b.company_id
    WHERE pp.pay_date >= ? AND pp.pay_date <= ? AND pp.branch_id IS NOT NULL
    GROUP BY b.id
  `).all(from, to) as BranchRow[];
  const svcBranches = db.prepare(`
    SELECT b.id AS branch_id, b.name AS branch_name, b.company_id AS company_id, c.name_th AS company_name
    FROM branches b
    LEFT JOIN companies c ON c.id = b.company_id
    WHERE b.id IN (SELECT DISTINCT branch_id FROM daily_service_charge WHERE substr(date, 1, 7) = ?)
  `).all(svcMonth) as BranchRow[];
  const companyBranches: BranchRow[] = [];
  const seenBranch = new Set<number>();
  for (const b of [...payrollBranches, ...svcBranches]) {
    if (seenBranch.has(b.branch_id)) continue;
    seenBranch.add(b.branch_id);
    companyBranches.push(b);
  }
  companyBranches.sort((a, b) =>
    (a.company_id == null ? 1 : 0) - (b.company_id == null ? 1 : 0)
    || (a.company_id ?? 0) - (b.company_id ?? 0)
    || a.branch_id - b.branch_id);

  type CompanyGroup = { key: number | null; name: string };
  const companyGroups: CompanyGroup[] = [];
  const companyByKey = new Map<number | null, CompanyGroup>();
  for (const cb of companyBranches) {
    if (companyByKey.has(cb.company_id)) continue;
    const g = { key: cb.company_id, name: cb.company_name ?? "ไม่ระบุบริษัท" };
    companyByKey.set(cb.company_id, g);
    companyGroups.push(g);
  }

  // Per (user, company) payroll aggregate — company-scoped totals (branch-stamped
  // periods only; legacy NULL-branch periods are pre-migration and excluded).
  type EmpCompanyRow = EmpRow & { company_id: number | null };
  const empCompanyRows = db.prepare(`
    SELECT pl.user_id, pl.display_name, u.title_prefix, b.company_id AS company_id,
           MAX(pl.employment_type) AS employment_type,
           MAX(pl.salary_tax_mode_snapshot) AS salary_tax_mode_snapshot,
           SUM(pl.gross_pay)  AS total_gross,
           SUM(pl.sso_amount) AS total_sso,
           SUM(pl.tax_amount) AS total_tax,
           SUM(pl.net_pay)    AS total_net,
           COUNT(*)            AS period_count,
           SUM(pl.drink_deductions)    AS total_drink,
           SUM(pl.mealpass_deductions) AS total_mealpass,
           -- FT only (a PT's unpaid day is simply no shift = no pay). The cut mirrors
           -- unpaidLeaveDeduction(): salary/30 per day, rounded — exact in every
           -- non-clamped case (prorated bases included); capped at the salary.
           SUM(CASE WHEN pl.employment_type = 'ft' THEN pl.unpaid_leave_days ELSE 0 END) AS total_unpaid_days,
           SUM(CASE WHEN pl.employment_type = 'ft' AND pl.unpaid_leave_days > 0 AND pl.monthly_salary_snapshot > 0
                    THEN MIN(ROUND(pl.monthly_salary_snapshot / 30.0 * pl.unpaid_leave_days, 2), pl.monthly_salary_snapshot)
                    ELSE 0 END) AS total_base_cut
    FROM payroll_lines pl
    JOIN payroll_periods pp ON pl.period_id = pp.id
    JOIN branches b ON b.id = pp.branch_id
    LEFT JOIN users u ON u.id = pl.user_id
    WHERE pp.pay_date >= ? AND pp.pay_date <= ? AND pp.branch_id IS NOT NULL
    GROUP BY pl.user_id, b.company_id
  `).all(from, to) as EmpCompanyRow[];

  // Service charge (owner 2026-08-01/08-02) — a SEPARATE monthly system. Money
  // landing in THIS month's pocket is the PREVIOUS month's SVC (paid ~the 20th),
  // exactly like the payslip, so we pull SVC for svcMonth. Sourced from the SAME
  // engine as the real payout (computeCompanySvcSummary: รวมกอง shared-pool +
  // manual gross overrides), so it ties out to the ใบหัก ณ ที่จ่าย exactly. We
  // keep name + type + tax mode alongside the money so a person who received ONLY
  // service charge (no payroll line) can still be listed.
  // mtg* = เบี้ยประชุม paid with this SVC round (see the merge below).
  type SvcAgg = { gross: number; wht: number; gi: number; net: number;
    mtgGross: number; mtgWht: number; mtgNet: number;
    displayName: string; employmentType: string | null; taxMode: "sso" | "wht" };
  const blankSvc = (displayName: string, employmentType: string | null, taxMode: "sso" | "wht"): SvcAgg =>
    ({ gross: 0, wht: 0, gi: 0, net: 0, mtgGross: 0, mtgWht: 0, mtgNet: 0, displayName, employmentType, taxMode });
  const svcByUserCompany = new Map<string, SvcAgg>();
  const addSvc = (companyKey: number | null, row: {
    userId: number; displayName: string; employmentType: string | null; taxMode: "sso" | "wht";
    netAllocation: number; whtAmount: number; groupInsurance: number; netPayout: number;
  }) => {
    if (!row.netAllocation && !row.netPayout) return;
    const k = `${row.userId}|${String(companyKey)}`;
    const cur = svcByUserCompany.get(k) ?? blankSvc(row.displayName, row.employmentType, row.taxMode);
    cur.gross += row.netAllocation;
    cur.wht += row.whtAmount;
    cur.gi += row.groupInsurance;
    cur.net += row.netPayout;
    svcByUserCompany.set(k, cur);
  };
  const seenCompany = new Set<number>();
  for (const cb of companyBranches) {
    if (cb.company_id == null || seenCompany.has(cb.company_id)) continue;
    seenCompany.add(cb.company_id);
    try { for (const row of computeCompanySvcSummary(cb.company_id, svcMonth).rows) addSvc(cb.company_id, row); }
    catch { /* svc may be absent for a company */ }
  }
  for (const cb of companyBranches) {
    if (cb.company_id != null) continue; // pre-migration NULL-company branch
    try { for (const row of computeMonthlySvcSummary(cb.branch_id, svcMonth).rows) addSvc(cb.company_id, row); }
    catch { /* no svc for this branch */ }
  }
  // เบี้ยประชุม (owner 2026-10-01) — paid WITH the service-charge round, so it lands
  // in the same pocket month as SVC. Sourced from the shared helper the export
  // document also reads, so this page and the ภ.ง.ด.1 / bank sheet can never
  // disagree. It covers every branch that has a fee (per-meeting override or home
  // branch), even one with no SVC/payroll activity; a meeting-fee-only person gets
  // a row via the synth loop below, filed under their real employment type.
  for (const m of meetingFeeByUserCompany(svcMonth).values()) {
    const k = `${m.userId}|${String(m.companyId)}`;
    const cur = svcByUserCompany.get(k) ?? blankSvc(m.displayName, m.employmentType, m.taxMode);
    cur.mtgGross += m.mtgGross; cur.mtgWht += m.mtgWht; cur.mtgNet += m.mtgNet;
    svcByUserCompany.set(k, cur);
  }
  const svcFor = (userId: number, companyKey: number | null): SvcAgg =>
    svcByUserCompany.get(`${userId}|${String(companyKey)}`) ?? blankSvc("", null, "sso");

  // Person rows per company = payroll people ∪ SVC-only people. A person who got
  // ONLY service charge (no payroll round this month) is synthesised with zero
  // wage figures so the SVC column + its WHT still land on the sheet.
  const rowsByCompany = new Map<number | null, EmpCompanyRow[]>();
  const payrollKeys = new Set<string>();
  for (const r of empCompanyRows) {
    payrollKeys.add(`${r.user_id}|${String(r.company_id)}`);
    if (!rowsByCompany.has(r.company_id)) rowsByCompany.set(r.company_id, []);
    rowsByCompany.get(r.company_id)!.push(r);
  }
  for (const [k, s] of svcByUserCompany) {
    if (payrollKeys.has(k)) continue; // already has a payroll row for this company
    const [uidStr, compStr] = k.split("|");
    const userId = Number(uidStr);
    const companyId = compStr === "null" ? null : Number(compStr);
    const synth: EmpCompanyRow = {
      user_id: userId, display_name: s.displayName, title_prefix: null, company_id: companyId,
      employment_type: (s.employmentType === "ft" || s.employmentType === "pt") ? s.employmentType : null,
      salary_tax_mode_snapshot: s.taxMode,
      total_gross: 0, total_sso: 0, total_tax: 0, total_net: 0, period_count: 0,
      total_drink: 0, total_mealpass: 0, total_unpaid_days: 0, total_base_cut: 0
    };
    if (!rowsByCompany.has(companyId)) rowsByCompany.set(companyId, []);
    rowsByCompany.get(companyId)!.push(synth);
  }
  // Stable display order within each company: FT, then PT, then others, by name.
  const rank = (t: string | null) => (t === "ft" ? 0 : t === "pt" ? 1 : 2);
  for (const list of rowsByCompany.values()) {
    list.sort((a, b) => rank(a.employment_type) - rank(b.employment_type) || a.display_name.localeCompare(b.display_name, "th"));
  }
  const grandSvc = [...svcByUserCompany.values()].reduce(
    (a, s) => ({ gross: a.gross + s.gross, wht: a.wht + s.wht, gi: a.gi + s.gi, net: a.net + s.net,
                 mtgGross: a.mtgGross + s.mtgGross, mtgWht: a.mtgWht + s.mtgWht, mtgNet: a.mtgNet + s.mtgNet }),
    { gross: 0, wht: 0, gi: 0, net: 0, mtgGross: 0, mtgWht: 0, mtgNet: 0 }
  );

  // Aggregate totals
  const totals = empRows.reduce(
    (acc, r) => ({
      gross: acc.gross + (r.total_gross ?? 0),
      sso:   acc.sso   + (r.total_sso   ?? 0),
      tax:   acc.tax   + (r.total_tax   ?? 0),
      net:   acc.net   + (r.total_net   ?? 0),
      ssoEmployees: acc.ssoEmployees + (r.salary_tax_mode_snapshot === "sso" ? 1 : 0),
      whtEmployees: acc.whtEmployees + (r.salary_tax_mode_snapshot === "wht" ? 1 : 0)
    }),
    { gross: 0, sso: 0, tax: 0, net: 0, ssoEmployees: 0, whtEmployees: 0 }
  );

  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, +1);

  // One merged table per employment type (owner 2026-07-27: แยกตาราง FT/PT +
  // รวม NAMA+HYPO เป็นแถวเดียว/คน). สังกัด = home branch; the per-branch net
  // columns are the where-they-worked split (บัญชีลงแยกสาขาตามนี้).
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const money = (v: number, cls = "") =>
    v ? <span className={cls}>{fmtMoney(v)}</span> : <span className="text-slate-300">—</span>;
  // Per-row figures in the owner's statement order (2026-08-02): ค่าตอบแทน (สะสม
  // ทุกรอบจ่ายในเดือน) → SVC → เบี้ยประชุม → รวมรายรับ → หัก (ปกส./ภาษี/ประกันกลุ่ม) →
  // รวมรับจริง. SVC + meeting-fee WHT fold into the tax column; take = income − all
  // deductions.
  const figuresFor = (r: EmpCompanyRow, companyKey: number | null) => {
    const comp = r.total_gross ?? 0;
    const svc = svcFor(r.user_id, companyKey);
    const income = comp + svc.gross + svc.mtgGross;
    const sso = r.total_sso ?? 0;
    const tax = (r.total_tax ?? 0) + svc.wht + svc.mtgWht;
    const gi = svc.gi;
    // หักระหว่างเดือน (owner 2026-10-01): everything withheld inside the pay
    // rounds besides ปกส./ภาษี — derived from the STORED net so รวมรับจริง always
    // equals what was transferred (same rule as the export document, incl. the
    // round2 at every step so SUM(REAL) dust never renders as "0.00"). The
    // itemised parts come from the line columns but are capped at the total:
    // when the welfare floor clamped a net to 0 the ledger columns exceed what
    // was really withheld. Any remainder is shown as อื่นๆ.
    const inRound = round2(Math.max(0, comp - (r.total_net ?? 0) - (r.total_sso ?? 0) - (r.total_tax ?? 0)));
    const drink = round2(Math.min(r.total_drink ?? 0, inRound));
    const mealpass = round2(Math.min(r.total_mealpass ?? 0, inRound - drink));
    const otherDed = round2(Math.max(0, inRound - drink - mealpass));
    const ded = round2(sso + tax + gi + inRound);
    return {
      comp, svcGross: svc.gross, mtgGross: svc.mtgGross, income, sso, tax, gi,
      inRound, drink, mealpass, otherDed,
      unpaidDays: r.total_unpaid_days ?? 0, baseCut: round2(r.total_base_cut ?? 0),
      ded, take: round2(income - ded)
    };
  };
  // One table per (employment type × tax mode). Read-only overview — every figure
  // is the month's accumulation across pay rounds, sourced from the per-branch
  // payroll runs (owner 2026-09-03: แยกสัดส่วน ปกส./หัก ณ ที่จ่าย เป็นคนละตาราง; ยุบ
  // คอลัมน์รายสาขา + ตารางรอบจ่ายให้เรียบ). Columns collapse to: สังกัด · ค่าตอบแทน ·
  // SVC · รวมรายรับ · หัก · สุทธิ.
  const empTable = (title: string, subtitle: string, accent: string, rows: EmpCompanyRow[], companyKey: number | null) => {
    if (rows.length === 0) return null;
    // Figures once per row — the subtotal and the row cells read the same objects.
    const figs = rows.map((r) => ({ r, f: figuresFor(r, companyKey) }));
    const sub = figs.reduce(
      (a, { f }) => {
        return {
          comp: a.comp + f.comp, svcGross: a.svcGross + f.svcGross, mtgGross: a.mtgGross + f.mtgGross, income: a.income + f.income,
          sso: a.sso + f.sso, tax: a.tax + f.tax, gi: a.gi + f.gi, inRound: a.inRound + f.inRound, ded: a.ded + f.ded, take: a.take + f.take
        };
      },
      { comp: 0, svcGross: 0, mtgGross: 0, income: 0, sso: 0, tax: 0, gi: 0, inRound: 0, ded: 0, take: 0 }
    );
    return (
      <div className="card overflow-x-auto">
        <h3 className="font-semibold text-slate-700 mb-0.5">
          <span className={accent}>{title}</span> · {rows.length} {t(lang, "admin.persona.payroll.col.staff")}
        </h3>
        <p className="text-xs text-slate-400 mb-3">{subtitle}</p>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <th className="py-2 pr-3">{t(lang, "admin.persona.payroll.col.staff")}</th>
              <th className="py-2 pr-3">สังกัด</th>
              <th className="py-2 pr-3 text-right whitespace-nowrap">ค่าตอบแทน</th>
              <th className="py-2 pr-3 text-right whitespace-nowrap">เซอร์วิสชาร์จ</th>
              <th className="py-2 pr-3 text-right whitespace-nowrap">เบี้ยประชุม</th>
              <th className="py-2 pr-3 text-right whitespace-nowrap">รวมรายรับ</th>
              <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.sso")}</th>
              <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.tax")}</th>
              <th className="py-2 pr-3 text-right whitespace-nowrap">ประกันกลุ่ม</th>
              <th className="py-2 pr-3 text-right whitespace-nowrap">หักระหว่างเดือน</th>
              <th className="py-2 pr-3 text-right whitespace-nowrap">รวมรับจริง</th>
            </tr>
          </thead>
          <tbody>
            {figs.map(({ r, f }) => {
              return (
                <tr key={r.user_id} className="border-b border-slate-100 last:border-0">
                  <td className="py-2 pr-3">
                    <div className="font-medium text-slate-800">{nameWithPrefix(r.title_prefix, r.display_name)}</div>
                    <Link
                      href={`/admin/persona/payroll/monthly-payslip/${r.user_id}?m=${month}`}
                      className="text-[11px] text-brand hover:underline"
                    >
                      สลิปรายเดือน →
                    </Link>
                  </td>
                  <td className="py-2 pr-3 text-xs text-slate-500 whitespace-nowrap">{homeByUser.get(r.user_id) ?? "—"}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {money(f.comp)}
                    {f.unpaidDays > 0 && (
                      <div className="text-[10px] text-rose-600 whitespace-nowrap">
                        ลาไม่รับค่าจ้าง/ขาดงาน {f.unpaidDays} วัน{f.baseCut > 0 ? ` −${fmtMoney(f.baseCut)}` : ""}
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-violet-700">{money(f.svcGross)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-fuchsia-700">{money(f.mtgGross)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums font-medium text-slate-800">{money(f.income)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-sky-700">{money(f.sso)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-amber-700">{money(f.tax)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-rose-600">{money(f.gi)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-rose-600">
                    {money(f.inRound)}
                    {f.inRound > 0 && (
                      <div className="text-[10px] text-slate-400 whitespace-nowrap">
                        {[
                          f.drink > 0 ? `เครื่องดื่ม ${fmtMoney(f.drink)}` : null,
                          f.mealpass > 0 ? `อาหารข้ามบริษัท ${fmtMoney(f.mealpass)}` : null,
                          f.otherDed > 0 ? `อื่นๆ ${fmtMoney(f.otherDed)}` : null
                        ].filter(Boolean).join(" · ")}
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums font-bold text-emerald-700">{fmtMoney(f.take)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-300 font-medium">
              <td className="py-2 pr-3" colSpan={2}>
                {t(lang, "admin.persona.payroll.detail.total")}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">{fmtMoney(sub.comp)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-violet-700">{fmtMoney(sub.svcGross)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-fuchsia-700">{fmtMoney(sub.mtgGross)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-slate-800">{fmtMoney(sub.income)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-sky-700">{fmtMoney(sub.sso)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-amber-700">{fmtMoney(sub.tax)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-rose-600">{fmtMoney(sub.gi)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-rose-600">{fmtMoney(sub.inRound)}</td>
              <td className="py-2 pr-3 text-right tabular-nums font-bold text-emerald-700">{fmtMoney(sub.take)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/admin/persona/payroll" className="text-sm text-slate-500 hover:text-brand">
          ← {t(lang, "admin.persona.payroll.backToHub")}
        </Link>
      </div>

      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.payroll.summary.title")}
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "admin.persona.payroll.summary.subtitle")}
        </p>
      </div>

      {/* Month nav */}
      <div className="card flex items-center justify-between gap-3 flex-wrap">
        <Link
          href={`/admin/persona/payroll/summary?m=${prev}`}
          className="text-sm px-3 py-1.5 rounded-md text-slate-700 hover:bg-slate-100 whitespace-nowrap"
        >
          ← {monthLabel(prev, lang)}
        </Link>
        <div className="text-lg font-bold text-slate-800 whitespace-nowrap">
          {monthLabel(month, lang)}
        </div>
        <Link
          href={`/admin/persona/payroll/summary?m=${next}`}
          className="text-sm px-3 py-1.5 rounded-md text-slate-700 hover:bg-slate-100 whitespace-nowrap"
        >
          {monthLabel(next, lang)} →
        </Link>
      </div>

      {/* Export for downstream documents (ภ.ง.ด.1 / SSO / bank). สร้างเอกสาร: pick
          company/branch + format (CSV/XLSX/PDF), with pay rounds + marked
          deductions (owner 2026-07-04 → 2026-09-06). */}
      {(empRows.length > 0 || svcByUserCompany.size > 0) && (
        <div className="flex justify-end">
          <ExportDialog month={month} scopes={listExportScopes(db, month)} />
        </div>
      )}

      {periods.length === 0 && companyGroups.length === 0 ? (
        <div className="card text-sm text-slate-500 py-8 text-center">
          {t(lang, "admin.persona.payroll.summary.empty")}
        </div>
      ) : (
        <>
          {/* Aggregate cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="card">
              <div className="text-xs text-slate-500">
                รวมรายรับ (ค่าตอบแทน + เซอร์วิสชาร์จ + เบี้ยประชุม)
              </div>
              <div className="text-2xl font-bold mt-1 text-slate-800">{fmtMoney(totals.gross + grandSvc.gross + grandSvc.mtgGross)}</div>
              <div className="text-xs text-slate-500 mt-1">
                ค่าตอบแทน {fmtMoney(totals.gross)}{grandSvc.gross > 0 ? ` + SVC ${fmtMoney(grandSvc.gross)}` : ""}{grandSvc.mtgGross > 0 ? ` + เบี้ยประชุม ${fmtMoney(grandSvc.mtgGross)}` : ""}
              </div>
            </div>
            <div className="card">
              <div className="text-xs text-slate-500">
                {t(lang, "admin.persona.payroll.col.sso")}
              </div>
              <div className="text-2xl font-bold mt-1 text-sky-700">{fmtMoney(totals.sso)}</div>
              <div className="text-xs text-slate-500 mt-1">
                {totals.ssoEmployees} {t(lang, "admin.persona.payroll.summary.ssoEmpLabel")}
              </div>
            </div>
            <div className="card">
              <div className="text-xs text-slate-500">
                {t(lang, "admin.persona.payroll.col.tax")}
              </div>
              <div className="text-2xl font-bold mt-1 text-amber-700">{fmtMoney(totals.tax + grandSvc.wht + grandSvc.mtgWht)}</div>
              <div className="text-xs text-slate-500 mt-1">
                {totals.whtEmployees} {t(lang, "admin.persona.payroll.summary.whtEmpLabel")}
                {grandSvc.gi > 0 ? ` · ประกันกลุ่ม ${fmtMoney(grandSvc.gi)}` : ""}
              </div>
            </div>
            <div className="card border-2 border-emerald-300 bg-emerald-50/40">
              <div className="text-xs text-slate-500">
                รวมรับจริง (โอนเข้าบัญชี)
              </div>
              <div className="text-2xl font-bold mt-1 text-emerald-700">{fmtMoney(totals.net + grandSvc.net + grandSvc.mtgNet)}</div>
              <div className="text-xs text-slate-500 mt-1">
                เงินเดือนสุทธิ {fmtMoney(totals.net)}{grandSvc.net > 0 ? ` + SVC ${fmtMoney(grandSvc.net)}` : ""}{grandSvc.mtgNet > 0 ? ` + เบี้ยประชุม ${fmtMoney(grandSvc.mtgNet)}` : ""}
              </div>
            </div>
          </div>

          {/* Per-employee breakdown — read-only overview. Split per บริษัท, then
              per ประเภทพนักงาน × โหมดภาษี (owner 2026-09-03). Every figure is the
              month's accumulation across pay rounds. */}
          <p className="text-xs text-slate-400">
            แยกตามบริษัท (บัญชีแยกกัน) → แยกพนักงานประจำ/พาร์ทไทม์ → แยกประกันสังคม/หัก ณ ที่จ่าย · ทุกยอดคือ<b>ยอดสะสมทั้งเดือน</b>จากทุกรอบจ่าย (ดูอย่างเดียว แก้ที่หน้าค่าตอบแทนรายสาขา) · ค่าตอบแทน + เซอร์วิสชาร์จ + เบี้ยประชุม = รวมรายรับ → หัก ปกส./ภาษี/ประกันกลุ่ม/หักระหว่างเดือน (เครื่องดื่ม · อาหารข้ามบริษัท · อื่นๆ) → รวมรับจริง (= ยอดโอนจริง) · ค่าตอบแทนที่มีบรรทัดแดงใต้ยอด = ฐานเงินเดือนถูกตัดจากลาไม่รับค่าจ้าง/ขาดงาน (ประกันสังคมจึงคิดจากฐานที่ลดแล้ว) · เซอร์วิสชาร์จและเบี้ยประชุมเป็นของเดือน{monthLabel(svcMonth, lang)} (จ่ายพร้อมกันในรอบเซอร์วิสชาร์จ)
          </p>
          {/* One section per company — the books are separate, so NAMA+HYPO and
              AT HOME never share a table (owner 2026-08-01). */}
          {companyGroups.map((g) => {
            const crows = rowsByCompany.get(g.key) ?? [];
            if (crows.length === 0) return null;
            // Split each employment type by tax mode so ประกันสังคม and
            // หัก ณ ที่จ่าย are separate tables (owner 2026-09-03: แยกสัดส่วน).
            // 'sso' or null → SSO group; 'wht' → WHT group. PT is uniformly WHT.
            const isWht = (r: EmpCompanyRow) => r.salary_tax_mode_snapshot === "wht";
            const cft = crows.filter((r) => r.employment_type === "ft");
            const cpt = crows.filter((r) => r.employment_type === "pt");
            const coth = crows.filter((r) => r.employment_type !== "ft" && r.employment_type !== "pt");
            const ftSso = cft.filter((r) => !isWht(r));
            const ftWht = cft.filter((r) => isWht(r));
            const othSso = coth.filter((r) => !isWht(r));
            const othWht = coth.filter((r) => isWht(r));
            // Company subtotal in the statement order: รวมรายรับ (ค่าตอบแทน + SVC) −
            // รายการหัก (ปกส. + ภาษี + SVC WHT + ประกันกลุ่ม) = รวมรับจริง. WHT + SSO
            // shown split so the accounting proportion is visible at a glance.
            const cAgg = crows.reduce((s, r) => {
              const f = figuresFor(r, g.key);
              return {
                income: s.income + f.income,
                wht: s.wht + f.tax,
                sso: s.sso + f.sso,
                gi: s.gi + f.gi,
                inRound: s.inRound + f.inRound
              };
            }, { income: 0, wht: 0, sso: 0, gi: 0, inRound: 0 });
            const cDed = cAgg.wht + cAgg.sso + cAgg.gi + cAgg.inRound;
            return (
              <div key={String(g.key)} className="space-y-3">
                <div className="border-l-4 border-brand pl-3 pt-2">
                  <h2 className="text-lg font-bold text-slate-800">{g.name}</h2>
                  <div className="text-xs text-slate-500 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>รวมรายรับ <b className="text-slate-800">{fmtMoney(cAgg.income)}</b></span>
                    <span>หัก ณ ที่จ่าย <b className="text-amber-700">{fmtMoney(cAgg.wht)}</b></span>
                    <span>ประกันสังคม <b className="text-sky-700">{fmtMoney(cAgg.sso)}</b></span>
                    {cAgg.gi > 0 && <span>ประกันกลุ่ม <b className="text-rose-600">{fmtMoney(cAgg.gi)}</b></span>}
                    {cAgg.inRound > 0 && <span>หักระหว่างเดือน <b className="text-rose-600">{fmtMoney(cAgg.inRound)}</b></span>}
                    <span>รวมรับจริง <b className="text-emerald-700">{fmtMoney(cAgg.income - cDed)}</b></span>
                  </div>
                </div>
                {empTable("พนักงานประจำ", "ประกันสังคม (ในระบบ)", "text-emerald-700", ftSso, g.key)}
                {empTable("พนักงานประจำ", "หัก ณ ที่จ่าย 3% (นอกระบบ)", "text-amber-700", ftWht, g.key)}
                {empTable("พาร์ทไทม์", "หัก ณ ที่จ่าย 3%", "text-violet-700", cpt, g.key)}
                {empTable("อื่นๆ", "ประกันสังคม (ในระบบ)", "text-slate-600", othSso, g.key)}
                {empTable("อื่นๆ", "หัก ณ ที่จ่าย 3%", "text-slate-600", othWht, g.key)}
              </div>
            );
          })}

          {/* Per-period list — collapsed by default (owner 2026-09-03: ยุบให้เรียบ).
              It's the audit trail of which rounds paid this month, not the headline. */}
          <details className="card">
            <summary className="font-semibold text-slate-700 cursor-pointer select-none">
              {t(lang, "admin.persona.payroll.summary.perPeriodTitle")}
              <span className="text-xs font-normal text-slate-400"> · {periods.length} รอบ (กดเพื่อดู)</span>
            </summary>
            <div className="overflow-x-auto mt-3">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <th className="py-2 pr-3">{t(lang, "admin.persona.payroll.col.cycle")}</th>
                  <th className="py-2 pr-3">{t(lang, "admin.persona.payroll.col.period")}</th>
                  <th className="py-2 pr-3">{t(lang, "admin.persona.payroll.col.payDate")}</th>
                  <th className="py-2 pr-3">{t(lang, "admin.persona.payroll.col.status")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.gross")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.sso")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.tax")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.net")}</th>
                  <th className="py-2 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {periods.map((p) => {
                  const catLabel =
                    p.cycle === "monthly" ? t(lang, "admin.persona.payroll.hub.cat.ftMonthly") :
                    p.target === "pt"     ? t(lang, "admin.persona.payroll.hub.cat.pt") :
                                            t(lang, "admin.persona.payroll.hub.cat.ftWeekly");
                  const catCls =
                    p.cycle === "monthly" ? "bg-emerald-100 text-emerald-700" :
                    p.target === "pt"     ? "bg-violet-100 text-violet-700" :
                                            "bg-emerald-50 text-emerald-700";
                  const statusCls =
                    p.status === "paid" ? "bg-sky-100 text-sky-700" :
                    p.status === "finalized" ? "bg-emerald-100 text-emerald-700" :
                    "bg-amber-100 text-amber-700";
                  const statusLabel = t(lang, `admin.persona.payroll.status.${p.status}` as any);
                  return (
                    <tr key={p.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <span className={`text-xs px-1.5 py-0.5 rounded ${catCls}`}>{catLabel}</span>
                      </td>
                      <td className="py-2 pr-3 text-slate-700 whitespace-nowrap">
                        {formatLongDate(p.period_start, lang)} – {formatLongDate(p.period_end, lang)}
                      </td>
                      <td className="py-2 pr-3 text-slate-700 whitespace-nowrap">{formatLongDate(p.pay_date, lang)}</td>
                      <td className="py-2 pr-3">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${statusCls}`}>
                          {statusLabel}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-right">{fmtMoney(p.total_gross ?? 0)}</td>
                      <td className="py-2 pr-3 text-right text-sky-700">{fmtMoney(p.total_sso ?? 0)}</td>
                      <td className="py-2 pr-3 text-right text-amber-700">{fmtMoney(p.total_tax ?? 0)}</td>
                      <td className="py-2 pr-3 text-right font-medium text-emerald-700">{fmtMoney(p.total_net ?? 0)}</td>
                      <td className="py-2 pr-3 text-right">
                        <Link
                          href={`/admin/persona/payroll/${p.id}`}
                          className="text-xs text-brand hover:underline whitespace-nowrap"
                        >
                          {t(lang, "admin.persona.payroll.hub.openPeriod")} →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
