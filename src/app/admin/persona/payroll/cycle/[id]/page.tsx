import Link from "next/link";
import type { Metadata } from "next";
import { requirePayrollAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t, type Lang } from "@/lib/i18n";
import { formatLongDate } from "@/lib/time";
import { fmtMoney } from "@/lib/format";
import { nameWithPrefix } from "@/lib/name";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "รอบบริษัท · ค่าตอบแทน" };

// A "company payroll cycle" groups the per-branch payroll_periods that share the
// same (cycle, target, period_start, period_end, pay_date) across one company's
// branches (owner 2026-07-27). Payroll is still computed AND posted per branch —
// each sibling period keeps its own books, so a PT working two branches still
// lands split (NAMA 2,000 / HYPO 2,000). This page just shows the whole cycle in
// one place; the cascade actions (finalize/pay/post all) are a thin loop over the
// same per-branch operations.

type RepPeriod = {
  id: number;
  cycle: string;
  target: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  branch_id: number | null;
  company_id: number | null;
};

type Sibling = {
  id: number;
  branch_id: number | null;
  branch_name: string | null;
  status: string;
  finalized_at: string | null;
  paid_at: string | null;
  posted_at: string | null;
  total_gross: number | null;
  total_net: number | null;
  line_count: number;
};

type EmpRow = {
  user_id: number;
  display_name: string;
  title_prefix: string | null;
  employment_type: string;
  salary_tax_mode_snapshot: string | null;
  total_gross: number | null;
  total_sso: number | null;
  total_tax: number | null;
  total_net: number | null;
};

function statusBadge(s: string, lang: Lang): { cls: string; label: string } {
  if (s === "draft") return { cls: "bg-amber-100 text-amber-700", label: t(lang, "admin.persona.payroll.status.draft") };
  if (s === "finalized") return { cls: "bg-emerald-100 text-emerald-700", label: t(lang, "admin.persona.payroll.status.finalized") };
  if (s === "paid") return { cls: "bg-sky-100 text-sky-700", label: t(lang, "admin.persona.payroll.status.paid") };
  return { cls: "bg-slate-100 text-slate-500", label: s };
}

export default function CompanyCyclePage({ params }: { params: { id: string } }) {
  requirePayrollAccess(); // gate — redirects if no payroll access
  const lang = getLang();
  const db = getDb();

  const repId = Number(params.id);
  if (!Number.isInteger(repId) || repId <= 0) {
    return <div className="card text-sm text-slate-600">{t(lang, "common.error")}</div>;
  }

  const rep = db.prepare(`
    SELECT p.id, p.cycle, p.target, p.period_start, p.period_end, p.pay_date, p.branch_id,
           b.company_id AS company_id
    FROM payroll_periods p
    LEFT JOIN branches b ON b.id = p.branch_id
    WHERE p.id = ?
  `).get(repId) as RepPeriod | undefined;
  if (!rep) {
    return <div className="card text-sm text-slate-600">{t(lang, "admin.persona.payroll.detail.notFound")}</div>;
  }

  // The company's branches (fall back to just this period if the rep is a legacy
  // NULL-branch period with no company).
  const companyBranchIds = rep.company_id != null
    ? (db.prepare("SELECT id FROM branches WHERE company_id = ?").all(rep.company_id) as Array<{ id: number }>).map((r) => r.id)
    : [];

  // Sibling periods = same cycle tuple, within the company (or the rep itself).
  const inClause = companyBranchIds.length > 0
    ? `p.branch_id IN (${companyBranchIds.map(() => "?").join(",")}) OR p.id = ?`
    : `p.id = ?`;
  const sibArgs = companyBranchIds.length > 0
    ? [rep.cycle, rep.target, rep.period_start, rep.period_end, rep.pay_date, ...companyBranchIds, rep.id]
    : [rep.cycle, rep.target, rep.period_start, rep.period_end, rep.pay_date, rep.id];
  const siblings = db.prepare(`
    SELECT p.id, p.branch_id, b.name AS branch_name, p.status,
           p.finalized_at, p.paid_at, p.posted_at,
           (SELECT SUM(gross_pay) FROM payroll_lines WHERE period_id = p.id) AS total_gross,
           (SELECT SUM(net_pay)   FROM payroll_lines WHERE period_id = p.id) AS total_net,
           (SELECT COUNT(*)       FROM payroll_lines WHERE period_id = p.id) AS line_count
    FROM payroll_periods p
    LEFT JOIN branches b ON b.id = p.branch_id
    WHERE p.cycle = ? AND p.target = ? AND p.period_start = ? AND p.period_end = ? AND p.pay_date = ?
      AND (${inClause})
    ORDER BY (p.branch_id IS NULL), b.id
  `).all(...sibArgs) as Sibling[];

  const sibIds = siblings.map((s) => s.id);
  const idPlaceholders = sibIds.map(() => "?").join(",");

  // Branch columns (label header for each sibling branch).
  const branchCols = siblings.map((s) => ({
    id: s.branch_id ?? 0,
    name: s.branch_name ?? t(lang, "admin.persona.payroll.cycle.noBranch")
  }));
  const multiBranch = branchCols.length > 1;

  // Merged per-employee rows across all sibling periods (1 row/person).
  const empRows = sibIds.length > 0 ? db.prepare(`
    SELECT pl.user_id,
           pl.display_name,
           u.title_prefix,
           MAX(pl.employment_type) AS employment_type,
           MAX(pl.salary_tax_mode_snapshot) AS salary_tax_mode_snapshot,
           SUM(pl.gross_pay)  AS total_gross,
           SUM(pl.sso_amount) AS total_sso,
           SUM(pl.tax_amount) AS total_tax,
           SUM(pl.net_pay)    AS total_net
    FROM payroll_lines pl
    LEFT JOIN users u ON u.id = pl.user_id
    WHERE pl.period_id IN (${idPlaceholders})
      -- Same FT-noise hides as the per-branch table: drop unconfigured FT
      -- (no salary) and an FT's empty line at a non-home branch.
      AND NOT (pl.employment_type = 'ft' AND COALESCE(pl.monthly_salary_snapshot, 0) = 0)
    GROUP BY pl.user_id
    ORDER BY (MAX(pl.employment_type) = 'ft') DESC,
             (MAX(pl.employment_type) = 'pt') DESC,
             pl.display_name
  `).all(...sibIds) as EmpRow[] : [];

  // user_id → period_id → net, to pull each employee's per-branch slice.
  const perBranchRows = sibIds.length > 0 ? db.prepare(`
    SELECT pl.user_id, pl.period_id, SUM(pl.net_pay) AS net, SUM(pl.gross_pay) AS gross
    FROM payroll_lines pl
    WHERE pl.period_id IN (${idPlaceholders})
    GROUP BY pl.user_id, pl.period_id
  `).all(...sibIds) as Array<{ user_id: number; period_id: number; net: number; gross: number }> : [];
  // Map a period id back to its branch id for the column lookup.
  const branchOfPeriod = new Map<number, number>();
  for (const s of siblings) branchOfPeriod.set(s.id, s.branch_id ?? 0);
  const netByUserBranch = new Map<number, Map<number, number>>();
  for (const r of perBranchRows) {
    const bId = branchOfPeriod.get(r.period_id) ?? 0;
    if (!netByUserBranch.has(r.user_id)) netByUserBranch.set(r.user_id, new Map());
    const m = netByUserBranch.get(r.user_id)!;
    m.set(bId, (m.get(bId) ?? 0) + (r.net ?? 0));
  }

  const ftRows = empRows.filter((r) => r.employment_type === "ft");
  const ptRows = empRows.filter((r) => r.employment_type === "pt");
  const otherRows = empRows.filter((r) => r.employment_type !== "ft" && r.employment_type !== "pt");

  // Combined status counts.
  const n = siblings.length;
  const nFinalized = siblings.filter((s) => s.status === "finalized" || s.status === "paid").length;
  const nPaid = siblings.filter((s) => s.status === "paid").length;
  const nPosted = siblings.filter((s) => s.posted_at != null).length;

  const catLabel =
    rep.cycle === "monthly" ? t(lang, "admin.persona.payroll.hub.cat.ftMonthly") :
    rep.target === "pt" ? t(lang, "admin.persona.payroll.hub.cat.pt") :
    rep.target === "ft" ? t(lang, "admin.persona.payroll.hub.cat.ftWeekly") :
    t(lang, "admin.persona.payroll.hub.targetAll");

  const empTable = (title: string, accent: string, rows: EmpRow[]) => {
    if (rows.length === 0) return null;
    const sub = rows.reduce(
      (a, r) => ({
        gross: a.gross + (r.total_gross ?? 0), sso: a.sso + (r.total_sso ?? 0),
        tax: a.tax + (r.total_tax ?? 0), net: a.net + (r.total_net ?? 0)
      }),
      { gross: 0, sso: 0, tax: 0, net: 0 }
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
              {multiBranch && branchCols.map((b) => (
                <th key={b.id} className="py-2 pr-3 text-right whitespace-nowrap">{b.name}</th>
              ))}
              <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.gross")}</th>
              <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.sso")}</th>
              <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.tax")}</th>
              <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.net")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const perB = netByUserBranch.get(r.user_id) ?? new Map<number, number>();
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
                  </td>
                  {multiBranch && branchCols.map((b) => {
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
                  <td className="py-2 pr-3 text-right font-bold text-emerald-700">{fmtMoney(r.total_net ?? 0)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-300 font-medium">
              <td className="py-2 pr-3" colSpan={multiBranch ? 1 + branchCols.length : 1}>
                {t(lang, "admin.persona.payroll.detail.total")}
              </td>
              <td className="py-2 pr-3 text-right">{fmtMoney(sub.gross)}</td>
              <td className="py-2 pr-3 text-right text-sky-700">{fmtMoney(sub.sso)}</td>
              <td className="py-2 pr-3 text-right text-amber-700">{fmtMoney(sub.tax)}</td>
              <td className="py-2 pr-3 text-right text-emerald-700">{fmtMoney(sub.net)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/persona/payroll" className="text-xs text-brand hover:underline">
          ← {t(lang, "admin.persona.payroll.hub.title")}
        </Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-1">
          {t(lang, "admin.persona.payroll.cycle.title")}
          <span className="ml-2 text-sm font-medium text-brand">· {catLabel}</span>
        </h1>
        <p className="text-sm text-slate-500">
          {formatLongDate(rep.period_start, lang)} – {formatLongDate(rep.period_end, lang)}
          <span className="mx-2 text-slate-300">|</span>
          {t(lang, "admin.persona.payroll.col.payDate")}: {formatLongDate(rep.pay_date, lang)}
        </p>
      </div>

      {/* Combined status strip */}
      <div className="card">
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <div className="text-xs text-slate-500">{t(lang, "admin.persona.payroll.status.finalized")}</div>
            <div className={`text-xl font-bold mt-0.5 ${nFinalized === n ? "text-emerald-600" : "text-amber-600"}`}>{nFinalized}/{n}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">{t(lang, "admin.persona.payroll.status.paid")}</div>
            <div className={`text-xl font-bold mt-0.5 ${nPaid === n ? "text-sky-600" : "text-slate-400"}`}>{nPaid}/{n}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">{t(lang, "admin.persona.payroll.cycle.posted")}</div>
            <div className={`text-xl font-bold mt-0.5 ${nPosted === n ? "text-emerald-600" : "text-slate-400"}`}>{nPosted}/{n}</div>
          </div>
        </div>
      </div>

      {/* Per-branch periods */}
      <div className="card overflow-x-auto">
        <h2 className="font-semibold text-slate-700 mb-3">{t(lang, "admin.persona.payroll.cycle.branchPeriods")}</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <th className="py-2 pr-3">{t(lang, "admin.persona.payroll.cycle.branch")}</th>
              <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.staff")}</th>
              <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.net")}</th>
              <th className="py-2 pr-3">{t(lang, "admin.persona.payroll.col.status")}</th>
              <th className="py-2 pr-3"></th>
            </tr>
          </thead>
          <tbody>
            {siblings.map((s) => {
              const badge = statusBadge(s.status, lang);
              return (
                <tr key={s.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="py-2 pr-3 font-medium text-slate-700">
                    {s.branch_name ?? t(lang, "admin.persona.payroll.cycle.noBranch")}
                  </td>
                  <td className="py-2 pr-3 text-right text-slate-600">{s.line_count}</td>
                  <td className="py-2 pr-3 text-right font-medium">{s.total_net != null ? fmtMoney(s.total_net) : "—"}</td>
                  <td className="py-2 pr-3">
                    <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${badge.cls}`}>{badge.label}</span>
                    {s.posted_at && (
                      <span className="ml-1 text-[10px] px-2 py-0.5 rounded font-medium bg-emerald-100 text-emerald-700">
                        {t(lang, "admin.persona.payroll.cycle.posted")}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <Link href={`/admin/persona/payroll/${s.id}`} className="text-xs text-brand hover:underline">
                      {t(lang, "admin.persona.payroll.hub.openPeriod")} →
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {multiBranch && (
        <p className="text-xs text-slate-400">
          {t(lang, "admin.persona.payroll.cycle.splitNote")}
        </p>
      )}
      {empTable(t(lang, "admin.persona.employees.employment.ft"), "text-emerald-700", ftRows)}
      {empTable(t(lang, "admin.persona.employees.employment.pt"), "text-violet-700", ptRows)}
      {empTable(t(lang, "admin.persona.payroll.cycle.other"), "text-slate-600", otherRows)}
    </div>
  );
}
