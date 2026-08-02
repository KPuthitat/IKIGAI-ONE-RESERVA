import Link from "next/link";
import type { Metadata } from "next";
import { requirePayrollAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t, type Lang } from "@/lib/i18n";
import { formatLongDate } from "@/lib/time";
import { fmtMoney } from "@/lib/format";
import { nameWithPrefix } from "@/lib/name";
import { computeMonthlySvcSummary } from "@/lib/service-charge";

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
           COUNT(*)            AS period_count
    FROM payroll_lines pl
    JOIN payroll_periods pp ON pl.period_id = pp.id
    LEFT JOIN users u ON u.id = pl.user_id
    WHERE pp.pay_date >= ? AND pp.pay_date <= ?
    GROUP BY pl.user_id
    ORDER BY (MAX(pl.employment_type) = 'ft') DESC,
             (MAX(pl.employment_type) = 'pt') DESC,
             pl.display_name
  `).all(from, to) as EmpRow[];

  // Per-branch split (owner 2026-07-27: บัญชีต้องแยกสาขา — ศุภาพิชญ์เข้า 2 สาขา
  // ได้สาขาละ 2,000 ต้องเห็นแยก NAMA/HYPO). Payroll is computed + posted per
  // branch (each branch's period holds that branch's hours→pay and posts to
  // its own daybook); this view only MERGES the display into one row/person
  // with a per-branch breakdown. It does NOT change the split — it surfaces it.
  const branchCols = db.prepare(`
    SELECT DISTINCT b.id, b.name
    FROM payroll_periods pp
    JOIN branches b ON b.id = pp.branch_id
    WHERE pp.pay_date >= ? AND pp.pay_date <= ? AND pp.branch_id IS NOT NULL
    ORDER BY b.id
  `).all(from, to) as Array<{ id: number; name: string }>;

  // user_id → branch_id → { net, gross } for the month.
  const perBranchRows = db.prepare(`
    SELECT pl.user_id, pp.branch_id AS branch_id,
           SUM(pl.net_pay)   AS net,
           SUM(pl.gross_pay) AS gross
    FROM payroll_lines pl
    JOIN payroll_periods pp ON pl.period_id = pp.id
    WHERE pp.pay_date >= ? AND pp.pay_date <= ? AND pp.branch_id IS NOT NULL
    GROUP BY pl.user_id, pp.branch_id
  `).all(from, to) as Array<{ user_id: number; branch_id: number; net: number; gross: number }>;
  // Per-branch column shows GROSS (ยอดก่อนหัก ณ ที่จ่าย) — owner 2026-08-01:
  // the books record the pre-withholding pay per branch, then SSO/WHT are shown
  // as separate deduction columns. (Was net before.)
  const grossByUserBranch = new Map<number, Map<number, number>>();
  for (const r of perBranchRows) {
    if (!grossByUserBranch.has(r.user_id)) grossByUserBranch.set(r.user_id, new Map());
    grossByUserBranch.get(r.user_id)!.set(r.branch_id, r.gross ?? 0);
  }

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
  // company; we render a section per company with only that company's branch
  // columns and its own subtotals, and aggregate each person's pay PER COMPANY
  // (not one cross-company total) so each company's section ties out to its own
  // books.
  const companyBranches = db.prepare(`
    SELECT b.id AS branch_id, b.name AS branch_name, b.company_id AS company_id,
           c.name_th AS company_name
    FROM payroll_periods pp
    JOIN branches b ON b.id = pp.branch_id
    LEFT JOIN companies c ON c.id = b.company_id
    WHERE pp.pay_date >= ? AND pp.pay_date <= ? AND pp.branch_id IS NOT NULL
    GROUP BY b.id
    ORDER BY (b.company_id IS NULL), b.company_id, b.id
  `).all(from, to) as Array<{ branch_id: number; branch_name: string; company_id: number | null; company_name: string | null }>;

  type CompanyGroup = { key: number | null; name: string; cols: Array<{ id: number; name: string }> };
  const companyGroups: CompanyGroup[] = [];
  const companyByKey = new Map<number | null, CompanyGroup>();
  for (const cb of companyBranches) {
    let g = companyByKey.get(cb.company_id);
    if (!g) {
      g = { key: cb.company_id, name: cb.company_name ?? "ไม่ระบุบริษัท", cols: [] };
      companyByKey.set(cb.company_id, g);
      companyGroups.push(g);
    }
    g.cols.push({ id: cb.branch_id, name: cb.branch_name });
  }

  // Per (user, company) aggregate — company-scoped totals (branch-stamped
  // periods only; legacy NULL-branch periods are pre-migration and excluded,
  // same as the per-branch columns above).
  type EmpCompanyRow = EmpRow & { company_id: number | null };
  const empCompanyRows = db.prepare(`
    SELECT pl.user_id, pl.display_name, u.title_prefix, b.company_id AS company_id,
           MAX(pl.employment_type) AS employment_type,
           MAX(pl.salary_tax_mode_snapshot) AS salary_tax_mode_snapshot,
           SUM(pl.gross_pay)  AS total_gross,
           SUM(pl.sso_amount) AS total_sso,
           SUM(pl.tax_amount) AS total_tax,
           SUM(pl.net_pay)    AS total_net,
           COUNT(*)            AS period_count
    FROM payroll_lines pl
    JOIN payroll_periods pp ON pl.period_id = pp.id
    JOIN branches b ON b.id = pp.branch_id
    LEFT JOIN users u ON u.id = pl.user_id
    WHERE pp.pay_date >= ? AND pp.pay_date <= ? AND pp.branch_id IS NOT NULL
    GROUP BY pl.user_id, b.company_id
    ORDER BY (MAX(pl.employment_type) = 'ft') DESC,
             (MAX(pl.employment_type) = 'pt') DESC,
             pl.display_name
  `).all(from, to) as EmpCompanyRow[];
  const rowsByCompany = new Map<number | null, EmpCompanyRow[]>();
  for (const r of empCompanyRows) {
    if (!rowsByCompany.has(r.company_id)) rowsByCompany.set(r.company_id, []);
    rowsByCompany.get(r.company_id)!.push(r);
  }

  // Service charge (owner 2026-08-01: SVC เป็นเงินที่พนักงานได้จริง ต้องอยู่ในสรุป
  // + สลิปด้วย). SVC is a SEPARATE monthly system (svc_payout_batches) — pull each
  // person's net SVC payout for the month per branch, attribute to that branch's
  // company, so the summary shows salary + SVC = รวมรับจริง. Keyed `${user}|${companyKey}`.
  const svcByUserCompany = new Map<string, number>();
  for (const cb of companyBranches) {
    let svc;
    try { svc = computeMonthlySvcSummary(cb.branch_id, month); }
    catch { continue; }
    for (const row of svc.rows) {
      if (!row.netPayout) continue;
      const k = `${row.userId}|${String(cb.company_id)}`;
      svcByUserCompany.set(k, (svcByUserCompany.get(k) ?? 0) + row.netPayout);
    }
  }
  const svcFor = (userId: number, companyKey: number | null): number =>
    svcByUserCompany.get(`${userId}|${String(companyKey)}`) ?? 0;

  // Split the merged rows into the two tables the owner wants kept separate.
  const ftRows = empRows.filter((r) => r.employment_type === "ft");
  const ptRows = empRows.filter((r) => r.employment_type === "pt");
  const otherRows = empRows.filter((r) => r.employment_type !== "ft" && r.employment_type !== "pt");
  const multiBranch = branchCols.length > 1;

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
  const empTable = (title: string, accent: string, rows: EmpCompanyRow[], cols: Array<{ id: number; name: string }>, companyKey: number | null) => {
    if (rows.length === 0) return null;
    const showBranchCols = cols.length > 1;
    const sub = rows.reduce(
      (a, r) => {
        const svc = svcFor(r.user_id, companyKey);
        return {
          gross: a.gross + (r.total_gross ?? 0), sso: a.sso + (r.total_sso ?? 0),
          tax: a.tax + (r.total_tax ?? 0), net: a.net + (r.total_net ?? 0),
          svc: a.svc + svc, take: a.take + (r.total_net ?? 0) + svc
        };
      },
      { gross: 0, sso: 0, tax: 0, net: 0, svc: 0, take: 0 }
    );
    return (
      <div className="card overflow-x-auto">
        <h2 className="font-semibold text-slate-700 mb-3">
          <span className={accent}>{title}</span> · {rows.length} {t(lang, "admin.persona.payroll.col.staff")}
        </h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <th className="py-2 pr-3">{t(lang, "admin.persona.payroll.col.staff")}</th>
              <th className="py-2 pr-3">สังกัด</th>
              {showBranchCols && cols.map((b) => (
                <th key={b.id} className="py-2 pr-3 text-right whitespace-nowrap">{b.name}</th>
              ))}
              <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.gross")}</th>
              <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.sso")}</th>
              <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.tax")}</th>
              <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.net")}</th>
              <th className="py-2 pr-3 text-right whitespace-nowrap">เซอร์วิสชาร์จ</th>
              <th className="py-2 pr-3 text-right whitespace-nowrap">รวมรับจริง</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const perB = grossByUserBranch.get(r.user_id) ?? new Map<number, number>();
              const svc = svcFor(r.user_id, companyKey);
              const take = (r.total_net ?? 0) + svc;
              return (
                <tr key={r.user_id} className="border-b border-slate-100 last:border-0">
                  <td className="py-2 pr-3">
                    <div className="font-medium text-slate-800 flex items-center gap-1.5 flex-wrap">
                      <span>{nameWithPrefix(r.title_prefix, r.display_name)}</span>
                      {r.salary_tax_mode_snapshot === "wht" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                          {t(lang, "admin.persona.employees.taxMode.whtTag")}
                        </span>
                      )}
                    </div>
                    <Link
                      href={`/admin/persona/payroll/monthly-payslip/${r.user_id}?m=${month}`}
                      className="text-[11px] text-brand hover:underline"
                    >
                      สลิปรายเดือน →
                    </Link>
                  </td>
                  <td className="py-2 pr-3 text-xs text-slate-500 whitespace-nowrap">{homeByUser.get(r.user_id) ?? "—"}</td>
                  {showBranchCols && cols.map((b) => {
                    const v = perB.get(b.id) ?? 0;
                    return (
                      <td key={b.id} className="py-2 pr-3 text-right tabular-nums">
                        {v ? fmtMoney(v) : <span className="text-slate-300">—</span>}
                      </td>
                    );
                  })}
                  <td className="py-2 pr-3 text-right">{fmtMoney(r.total_gross ?? 0)}</td>
                  <td className="py-2 pr-3 text-right text-sky-700">{fmtMoney(r.total_sso ?? 0)}</td>
                  <td className="py-2 pr-3 text-right text-amber-700">{fmtMoney(r.total_tax ?? 0)}</td>
                  <td className="py-2 pr-3 text-right text-emerald-700">{fmtMoney(r.total_net ?? 0)}</td>
                  <td className="py-2 pr-3 text-right text-violet-700">{svc ? fmtMoney(svc) : <span className="text-slate-300">—</span>}</td>
                  <td className="py-2 pr-3 text-right font-bold text-slate-800">{fmtMoney(take)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-300 font-medium">
              <td className="py-2 pr-3" colSpan={showBranchCols ? 2 + cols.length : 2}>
                {t(lang, "admin.persona.payroll.detail.total")}
              </td>
              <td className="py-2 pr-3 text-right">{fmtMoney(sub.gross)}</td>
              <td className="py-2 pr-3 text-right text-sky-700">{fmtMoney(sub.sso)}</td>
              <td className="py-2 pr-3 text-right text-amber-700">{fmtMoney(sub.tax)}</td>
              <td className="py-2 pr-3 text-right text-emerald-700">{fmtMoney(sub.net)}</td>
              <td className="py-2 pr-3 text-right text-violet-700">{fmtMoney(sub.svc)}</td>
              <td className="py-2 pr-3 text-right font-bold text-slate-800">{fmtMoney(sub.take)}</td>
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

      {/* Export for downstream documents (ภ.ง.ด.1 / SSO / bank) — owner 2026-07-04 */}
      {empRows.length > 0 && (
        <div className="flex justify-end">
          <a
            href={`/api/admin/persona/payroll/summary/csv?m=${month}`}
            className="text-sm px-4 py-2 rounded-lg border border-brand text-brand font-medium hover:bg-amber-50"
          >
            ⬇ ดาวน์โหลด CSV (ต่อพนักงาน)
          </a>
        </div>
      )}

      {periods.length === 0 ? (
        <div className="card text-sm text-slate-500 py-8 text-center">
          {t(lang, "admin.persona.payroll.summary.empty")}
        </div>
      ) : (
        <>
          {/* Aggregate cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="card">
              <div className="text-xs text-slate-500">
                {t(lang, "admin.persona.payroll.summary.totalGross")}
              </div>
              <div className="text-2xl font-bold mt-1 text-slate-800">{fmtMoney(totals.gross)}</div>
              <div className="text-xs text-slate-500 mt-1">
                {periods.length} {t(lang, "admin.persona.payroll.summary.periodsLabel")} · {empRows.length} {t(lang, "admin.persona.payroll.col.staff")}
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
              <div className="text-2xl font-bold mt-1 text-amber-700">{fmtMoney(totals.tax)}</div>
              <div className="text-xs text-slate-500 mt-1">
                {totals.whtEmployees} {t(lang, "admin.persona.payroll.summary.whtEmpLabel")}
              </div>
            </div>
            <div className="card border-2 border-emerald-300 bg-emerald-50/40">
              <div className="text-xs text-slate-500">
                {t(lang, "admin.persona.payroll.summary.totalNet")}
              </div>
              <div className="text-2xl font-bold mt-1 text-emerald-700">{fmtMoney(totals.net)}</div>
              <div className="text-xs text-slate-500 mt-1">
                {t(lang, "admin.persona.payroll.summary.totalNetHint")}
              </div>
            </div>
          </div>

          {/* Per-employee breakdown — split FT / PT, one row per person,
              per-branch net columns show the split that lands in each branch's
              books (owner 2026-07-27). */}
          {multiBranch && (
            <p className="text-xs text-slate-400">
              แยกตามบริษัท (บัญชีแยกกัน) · คอลัมน์รายสาขา = ยอดก่อนหัก ณ ที่จ่าย (gross) ที่ลงบัญชีแต่ละสาขา · แล้วหัก ปกส./ภาษี → เหลือสุทธิ
            </p>
          )}
          {/* One section per company — the books are separate, so NAMA+HYPO and
              AT HOME never share a table (owner 2026-08-01). */}
          {companyGroups.map((g) => {
            const crows = rowsByCompany.get(g.key) ?? [];
            if (crows.length === 0) return null;
            const cft = crows.filter((r) => r.employment_type === "ft");
            const cpt = crows.filter((r) => r.employment_type === "pt");
            const coth = crows.filter((r) => r.employment_type !== "ft" && r.employment_type !== "pt");
            const cnet = crows.reduce((s, r) => s + (r.total_net ?? 0), 0);
            const cgross = crows.reduce((s, r) => s + (r.total_gross ?? 0), 0);
            const csvc = crows.reduce((s, r) => s + svcFor(r.user_id, g.key), 0);
            return (
              <div key={String(g.key)} className="space-y-3">
                <div className="flex items-baseline justify-between gap-3 flex-wrap border-l-4 border-brand pl-3 pt-2">
                  <h2 className="text-lg font-bold text-slate-800">{g.name}</h2>
                  <div className="text-xs text-slate-500">
                    เงินเดือนสุทธิ <b className="text-emerald-700">{fmtMoney(cnet)}</b>
                    {csvc > 0 && <>{" + "}เซอร์วิสชาร์จ <b className="text-violet-700">{fmtMoney(csvc)}</b></>}
                    {" = "}รวมรับจริง <b className="text-slate-800">{fmtMoney(cnet + csvc)}</b>
                  </div>
                </div>
                {empTable(t(lang, "admin.persona.employees.employment.ft"), "text-emerald-700", cft, g.cols, g.key)}
                {empTable(t(lang, "admin.persona.employees.employment.pt"), "text-violet-700", cpt, g.cols, g.key)}
                {empTable("อื่นๆ", "text-slate-600", coth, g.cols, g.key)}
              </div>
            );
          })}

          {/* Per-period list */}
          <div className="card overflow-x-auto">
            <h2 className="font-semibold text-slate-700 mb-3">
              {t(lang, "admin.persona.payroll.summary.perPeriodTitle")}
            </h2>
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
        </>
      )}
    </div>
  );
}
