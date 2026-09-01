import Link from "next/link";
import type { Metadata } from "next";
import { requirePayrollAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t, type Lang } from "@/lib/i18n";
import { formatLongDate } from "@/lib/time";
import { fmtMoney } from "@/lib/format";
import { nameWithPrefix } from "@/lib/name";
import { resolveCompanyCycle } from "@/lib/payroll-cycle";
import CompanyCycleActions from "./CompanyCycleActions";
import PtBreakdownTable from "./PtBreakdownTable";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "รอบบริษัท · ค่าตอบแทน" };

// A "company payroll cycle" groups the per-branch payroll_periods that share the
// same (cycle, target, period_start, period_end, pay_date) across one company's
// branches (owner 2026-07-27). Payroll is still computed AND posted per branch —
// each sibling period keeps its own books, so a PT working two branches still
// lands split (NAMA 2,000 / HYPO 2,000). This page just shows the whole cycle in
// one place; the cascade actions (finalize/pay/post all) are a thin loop over the
// same per-branch operations.

type EmpRow = {
  user_id: number;
  display_name: string;
  title_prefix: string | null;
  employment_type: string;
  salary_tax_mode_snapshot: string | null;
  total_regular_minutes: number | null;
  total_ot_minutes: number | null;
  total_base_pay: number | null;
  total_ot_pay: number | null;
  total_gross: number | null;
  total_sso: number | null;
  total_tax: number | null;
  total_net: number | null;
};

// Minutes → "Xh Ym" (mirror of the per-period detail helper) for the read-only
// calculation columns on the company cycle page.
function fmtMin(min: number): string {
  if (!min) return "—";
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

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

  const resolved = resolveCompanyCycle(db, repId);
  if (!resolved) {
    return <div className="card text-sm text-slate-600">{t(lang, "admin.persona.payroll.detail.notFound")}</div>;
  }
  const { rep, siblings } = resolved;

  const sibIds = siblings.map((s) => s.id);
  const idPlaceholders = sibIds.map(() => "?").join(",");

  // Branch columns (label header for each sibling branch).
  const branchCols = siblings.map((s) => ({
    id: s.branch_id ?? 0,
    name: s.branch_name ?? t(lang, "admin.persona.payroll.cycle.noBranch")
  }));
  const multiBranch = branchCols.length > 1;
  // period id → branch name — lets the PT per-day breakdown tag each day with
  // the branch it was worked at, so a two-branch person's days are traceable
  // (owner 2026-09-01: "เข้าสองสาขา ควรเห็นแต่ละวันสาขาไหน ยอดเท่าไร").
  const branchByPeriodObj: Record<number, string> = {};
  for (const s of siblings) {
    branchByPeriodObj[s.id] = s.branch_name ?? t(lang, "admin.persona.payroll.cycle.noBranch");
  }

  // Merged per-employee rows across all sibling periods (1 row/person).
  const empRows = sibIds.length > 0 ? db.prepare(`
    SELECT pl.user_id,
           pl.display_name,
           u.title_prefix,
           MAX(pl.employment_type) AS employment_type,
           MAX(pl.salary_tax_mode_snapshot) AS salary_tax_mode_snapshot,
           SUM(pl.regular_minutes) AS total_regular_minutes,
           SUM(pl.ot_minutes)      AS total_ot_minutes,
           SUM(pl.base_pay)        AS total_base_pay,
           SUM(pl.ot_pay)          AS total_ot_pay,
           SUM(pl.gross_pay)  AS total_gross,
           SUM(pl.sso_amount) AS total_sso,
           SUM(pl.tax_amount) AS total_tax,
           SUM(pl.net_pay)    AS total_net
    FROM payroll_lines pl
    LEFT JOIN users u ON u.id = pl.user_id
    WHERE pl.period_id IN (${idPlaceholders})
      -- Drop unconfigured FT (no salary set), same as the per-branch table. An
      -- FT's empty non-home line needs no special hide here: GROUP BY user_id
      -- collapses it into the single merged row (adds +0), so nobody doubles up.
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
  // Per-branch column shows GROSS (ยอดก่อนหัก ณ ที่จ่าย) — owner 2026-08-24, to
  // match the payroll summary page: the books record the pre-withholding pay per
  // branch, then SSO/WHT are shown as separate columns. (Was net before.)
  const grossByUserBranch = new Map<number, Map<number, number>>();
  for (const r of perBranchRows) {
    const bId = branchOfPeriod.get(r.period_id) ?? 0;
    if (!grossByUserBranch.has(r.user_id)) grossByUserBranch.set(r.user_id, new Map());
    const m = grossByUserBranch.get(r.user_id)!;
    m.set(bId, (m.get(bId) ?? 0) + (r.gross ?? 0));
  }

  const ftRows = empRows.filter((r) => r.employment_type === "ft");
  const ptRows = empRows.filter((r) => r.employment_type === "pt");
  const otherRows = empRows.filter((r) => r.employment_type !== "ft" && r.employment_type !== "pt");

  // Which sibling period(s) each employee has a line in — so the PT table can
  // lazy-fetch each person's per-day breakdown (recheck before paying, owner
  // 2026-08). A PT working two branches has one line per branch-period.
  const periodIdsByUser: Record<number, number[]> = {};
  for (const r of perBranchRows) {
    (periodIdsByUser[r.user_id] ??= []).push(r.period_id);
  }
  const grossByUserBranchObj: Record<number, Record<number, number>> = {};
  for (const [uid, m] of grossByUserBranch) {
    grossByUserBranchObj[uid] = Object.fromEntries(m);
  }

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
        base: a.base + (r.total_base_pay ?? 0), otPay: a.otPay + (r.total_ot_pay ?? 0),
        gross: a.gross + (r.total_gross ?? 0), sso: a.sso + (r.total_sso ?? 0),
        tax: a.tax + (r.total_tax ?? 0), net: a.net + (r.total_net ?? 0)
      }),
      { base: 0, otPay: 0, gross: 0, sso: 0, tax: 0, net: 0 }
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
              <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.regularHrs")}</th>
              <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.otHrs")}</th>
              <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.basePay")}</th>
              <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.otPay")}</th>
              <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.gross")}</th>
              <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.sso")}</th>
              <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.tax")}</th>
              <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.net")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const perB = grossByUserBranch.get(r.user_id) ?? new Map<number, number>();
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
                  <td className="py-2 pr-3 text-right text-slate-600 tabular-nums">{fmtMin(r.total_regular_minutes ?? 0)}</td>
                  <td className="py-2 pr-3 text-right text-amber-700 tabular-nums">{(r.total_ot_minutes ?? 0) > 0 ? fmtMin(r.total_ot_minutes ?? 0) : "—"}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{fmtMoney(r.total_base_pay ?? 0)}</td>
                  <td className="py-2 pr-3 text-right text-amber-700 tabular-nums">{(r.total_ot_pay ?? 0) > 0 ? fmtMoney(r.total_ot_pay ?? 0) : "—"}</td>
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
              <td colSpan={2}></td>
              <td className="py-2 pr-3 text-right">{fmtMoney(sub.base)}</td>
              <td className="py-2 pr-3 text-right text-amber-700">{fmtMoney(sub.otPay)}</td>
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

      {/* One-action cascade across all branches */}
      <CompanyCycleActions
        lang={lang}
        repId={rep.id}
        siblings={siblings.map((s) => ({
          id: s.id,
          branch_name: s.branch_name,
          status: s.status,
          posted: s.posted_at != null
        }))}
      />

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
      {ptRows.length > 0 && (
        <PtBreakdownTable
          rows={ptRows}
          periodIdsByUser={periodIdsByUser}
          branchCols={branchCols}
          grossByUserBranch={grossByUserBranchObj}
          branchByPeriod={branchByPeriodObj}
          multiBranch={multiBranch}
        />
      )}
      {empTable(t(lang, "admin.persona.payroll.cycle.other"), "text-slate-600", otherRows)}
    </div>
  );
}
