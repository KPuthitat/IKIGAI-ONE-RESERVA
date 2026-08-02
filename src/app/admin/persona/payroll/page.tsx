import Link from "next/link";
import type { Metadata } from "next";
import { requirePayrollAccess } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t, type Lang } from "@/lib/i18n";
import { formatLongDate } from "@/lib/time";
import { fmtMoney } from "@/lib/format";
import PayPeriodPicker, { type ExistingPeriod } from "./PayPeriodPicker";
import { Icon } from "@/components/Icon";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "ค่าตอบแทน · PERSONA" };

type Counter = { n: number };
type Settings = {
  ot_mode: "flat" | "legal";
  ot_flat_per_15min: number;
  pt_default_hourly_rate: number;
};

function formatBkkDate(d: string, lang: Lang): string {
  return formatLongDate(d, lang);
}

function statusBadge(s: string, lang: Lang): { cls: string; label: string } {
  if (s === "draft") return {
    cls: "bg-amber-100 text-amber-700",
    label: t(lang, "admin.persona.payroll.status.draft")
  };
  if (s === "finalized") return {
    cls: "bg-emerald-100 text-emerald-700",
    label: t(lang, "admin.persona.payroll.status.finalized")
  };
  return { cls: "bg-slate-100 text-slate-500", label: s };
}

export default function PayrollHubPage() {
  const user = requirePayrollAccess();
  const lang = getLang();
  const db = getDb();

  if (!user.activeBranchId) {
    return (
      <div className="card text-sm text-slate-600">
        {t(lang, "admin.notAssignedBranch")}
      </div>
    );
  }
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) {
    return <div className="card text-sm text-slate-600">{t(lang, "common.error")}</div>;
  }

  // Setup completeness — scoped to employees assigned to this branch.
  // Same employee at both branches counts in both branches' setup
  // checks (since they need their pay info filled either way).
  const ptMissing = (db.prepare(`
    SELECT COUNT(*) AS n FROM users u
    INNER JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?
    WHERE u.role IN ('staff', 'admin') AND u.employment_type = 'pt'
      AND u.is_test_account = 0
      AND (u.hourly_rate IS NULL OR u.hourly_rate = 0)
  `).get(branch.id) as Counter).n;

  const ftMissing = (db.prepare(`
    SELECT COUNT(*) AS n FROM users u
    INNER JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?
    WHERE u.role IN ('staff', 'admin') AND u.employment_type = 'ft'
      AND u.is_test_account = 0
      AND (u.monthly_salary IS NULL OR u.monthly_salary = 0 OR u.pay_cycle IS NULL)
  `).get(branch.id) as Counter).n;

  const totalStaff = (db.prepare(`
    SELECT COUNT(*) AS n FROM users u
    INNER JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?
    WHERE u.role IN ('staff', 'admin') AND u.employment_type IS NOT NULL
      AND u.is_test_account = 0
  `).get(branch.id) as Counter).n;

  const settings = db.prepare(`
    SELECT ot_mode, ot_flat_per_15min, pt_default_hourly_rate
    FROM payroll_settings WHERE id = 1
  `).get() as Settings | undefined;

  // Existing periods for THIS branch (owner 2026-06-10: payroll is now
  // per-branch). Legacy periods created before branch scoping carry
  // branch_id NULL and still show everywhere so nothing disappears.
  const existing = db.prepare(`
    SELECT p.id, p.cycle, p.target, p.period_start, p.period_end, p.pay_date, p.status,
           (SELECT SUM(gross_pay) FROM payroll_lines WHERE period_id = p.id) AS total_gross,
           (SELECT SUM(net_pay)   FROM payroll_lines WHERE period_id = p.id) AS total_net,
           (SELECT COUNT(*)       FROM payroll_lines WHERE period_id = p.id) AS line_count
    FROM payroll_periods p
    WHERE p.branch_id = ? OR p.branch_id IS NULL
    ORDER BY p.period_end DESC, p.id DESC
  `).all(branch.id) as ExistingPeriod[];

  // Recent periods table (last 12)
  const recent = existing.slice(0, 12);

  const otModeLabel = settings?.ot_mode === "flat"
    ? t(lang, "admin.persona.payroll.otFlatLabel", {
        baht: String(settings.ot_flat_per_15min),
        perHour: String(settings.ot_flat_per_15min * 4)
      })
    : t(lang, "admin.persona.payroll.otLegalLabel");

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.payroll.hub.title")}
          <span className="ml-2 text-sm font-medium text-brand">· {branch.name}</span>
        </h1>
        <p className="text-sm text-slate-500">
          {t(lang, "admin.persona.payroll.hub.subtitle")}
        </p>
        {/* Phase 2 only filters the staff-setup metrics by branch.
            Period creation + payroll lines themselves are still global
            (a single period covers all branches). The per-branch
            split happens in the Phase 3 compute-engine refactor. */}
        <div className="mt-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 inline-block">
          {t(lang, "admin.persona.payroll.hub.branchScopeNote")}
        </div>
      </div>

      {/* Setup status */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="card">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-slate-500">
              {t(lang, "admin.persona.payroll.hub.totalStaff")}
            </div>
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
              <Icon name="users" className="h-4 w-4" />
            </span>
          </div>
          <div className="text-2xl font-bold mt-1 text-slate-800 tabular-nums">{totalStaff}</div>
        </div>
        <Link href="/admin/persona/employees" className="card hover:shadow-md hover:-translate-y-0.5 transition block">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-slate-500">
              {t(lang, "admin.persona.payroll.hub.ptMissing")}
            </div>
            <span className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ${ptMissing > 0 ? "bg-amber-50 text-amber-600" : "bg-emerald-50 text-emerald-600"}`}>
              <Icon name={ptMissing > 0 ? "alert" : "check"} className="h-4 w-4" />
            </span>
          </div>
          <div className={`text-2xl font-bold mt-1 tabular-nums ${ptMissing > 0 ? "text-amber-600" : "text-emerald-600"}`}>
            {ptMissing}
          </div>
          {ptMissing > 0 && (
            <div className="text-xs text-amber-700 mt-1">
              {t(lang, "admin.persona.payroll.hub.setupHint")} →
            </div>
          )}
        </Link>
        <Link href="/admin/persona/employees" className="card hover:shadow-md hover:-translate-y-0.5 transition block">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-slate-500">
              {t(lang, "admin.persona.payroll.hub.ftMissing")}
            </div>
            <span className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ${ftMissing > 0 ? "bg-amber-50 text-amber-600" : "bg-emerald-50 text-emerald-600"}`}>
              <Icon name={ftMissing > 0 ? "alert" : "check"} className="h-4 w-4" />
            </span>
          </div>
          <div className={`text-2xl font-bold mt-1 tabular-nums ${ftMissing > 0 ? "text-amber-600" : "text-emerald-600"}`}>
            {ftMissing}
          </div>
          {ftMissing > 0 && (
            <div className="text-xs text-amber-700 mt-1">
              {t(lang, "admin.persona.payroll.hub.setupHint")} →
            </div>
          )}
        </Link>
      </div>

      {/* Monthly summary link */}
      <Link
        href="/admin/persona/payroll/summary"
        className="card border-l-4 border-emerald-400 bg-emerald-50/40 hover:shadow-md hover:-translate-y-0.5 transition block"
      >
        <div className="flex items-center gap-3">
          <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-600">
            <Icon name="calendar" className="h-6 w-6" />
          </span>
          <div className="flex-1">
            <h2 className="font-bold text-slate-800">
              {t(lang, "admin.persona.payroll.hub.summaryTitle")}
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              {t(lang, "admin.persona.payroll.hub.summaryDesc")}
            </p>
          </div>
          <Icon name="arrowRight" className="h-5 w-5 text-brand shrink-0" strokeWidth={2.25} />
        </div>
      </Link>

      {/* Settings link (compact) */}
      <Link
        href="/admin/persona/payroll/settings"
        className="card border-l-4 border-sky-300 bg-sky-50 hover:shadow-md hover:-translate-y-0.5 transition block"
      >
        <div className="flex items-center gap-3">
          <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-sky-100 text-sky-600">
            <Icon name="settings" className="h-6 w-6" />
          </span>
          <div className="flex-1">
            <h2 className="font-bold text-slate-800">
              {t(lang, "admin.persona.payroll.hub.settingsTitle")}
            </h2>
            <div className="text-xs text-slate-500 mt-1">
              {t(lang, "admin.persona.payroll.hub.currentOtMode")}: <span className="font-medium text-slate-700">{otModeLabel}</span>
              {settings && (
                <>
                  <span className="mx-2 text-slate-300">|</span>
                  {t(lang, "admin.persona.payroll.hub.ptDefaultRate")}: <span className="font-medium text-slate-700">{settings.pt_default_hourly_rate} {t(lang, "admin.persona.employees.bahtPerHour")}</span>
                </>
              )}
            </div>
          </div>
          <Icon name="arrowRight" className="h-5 w-5 text-brand shrink-0" strokeWidth={2.25} />
        </div>
      </Link>

      {/* Pay period picker — auto-listed by month based on pay_date */}
      <PayPeriodPicker lang={lang} existing={existing} />

      {/* Recent periods table */}
      <div className="card">
        <h2 className="font-semibold text-slate-700 mb-3">
          {t(lang, "admin.persona.payroll.hub.recentPeriods")}
        </h2>
        {recent.length === 0 ? (
          <p className="text-sm text-slate-400 py-6 text-center">
            {t(lang, "admin.persona.payroll.hub.noPeriods")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <th className="py-2 pr-3">{t(lang, "admin.persona.payroll.col.cycle")}</th>
                  <th className="py-2 pr-3">{t(lang, "admin.persona.payroll.col.period")}</th>
                  <th className="py-2 pr-3">{t(lang, "admin.persona.payroll.col.payDate")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.staff")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.gross")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.net")}</th>
                  <th className="py-2 pr-3">{t(lang, "admin.persona.payroll.col.status")}</th>
                  <th className="py-2 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {recent.map((p) => {
                  const badge = statusBadge(p.status, lang);
                  // Combined category label (single short string)
                  const catLabel =
                    p.cycle === "monthly" ? t(lang, "admin.persona.payroll.hub.cat.ftMonthly") :
                    p.target === "pt" ? t(lang, "admin.persona.payroll.hub.cat.pt") :
                    p.target === "ft" ? t(lang, "admin.persona.payroll.hub.cat.ftWeekly") :
                    t(lang, "admin.persona.payroll.hub.targetAll");
                  const catCls =
                    p.cycle === "monthly" ? "bg-emerald-100 text-emerald-700" :
                    p.target === "pt" ? "bg-violet-100 text-violet-700" :
                    p.target === "ft" ? "bg-emerald-50 text-emerald-700" :
                    "bg-slate-100 text-slate-700";
                  return (
                    <tr key={p.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <span className={`text-xs px-1.5 py-0.5 rounded ${catCls}`}>
                          {catLabel}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-slate-700">
                        {formatBkkDate(p.period_start, lang)} – {formatBkkDate(p.period_end, lang)}
                      </td>
                      <td className="py-2 pr-3 text-slate-700">{formatBkkDate(p.pay_date, lang)}</td>
                      <td className="py-2 pr-3 text-right text-slate-600">{p.line_count}</td>
                      <td className="py-2 pr-3 text-right">
                        {p.total_gross != null ? fmtMoney(p.total_gross) : "—"}
                      </td>
                      <td className="py-2 pr-3 text-right font-medium">
                        {p.total_net != null ? fmtMoney(p.total_net) : "—"}
                      </td>
                      <td className="py-2 pr-3">
                        <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${badge.cls}`}>
                          {badge.label}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-right whitespace-nowrap">
                        <Link href={`/admin/persona/payroll/cycle/${p.id}`} className="text-xs text-slate-500 hover:text-brand hover:underline">
                          {t(lang, "admin.persona.payroll.hub.viewAllBranches")}
                        </Link>
                        <span className="mx-1 text-slate-300">·</span>
                        <Link href={`/admin/persona/payroll/${p.id}`} className="text-xs text-brand hover:underline">
                          {t(lang, "admin.persona.payroll.hub.openPeriod")} →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Future phases */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="card opacity-60">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-400">
              <Icon name="doc" className="h-5 w-5" />
            </span>
            <h3 className="font-medium text-slate-700">
              {t(lang, "admin.persona.payroll.hub.payslipTitle")}
            </h3>
          </div>
          <p className="text-xs text-slate-500 mt-2">
            {t(lang, "admin.persona.payroll.hub.phase3Note")}
          </p>
        </div>
        <Link href="/admin/persona/service-charge" className="card block hover:shadow-lg hover:-translate-y-0.5 transition">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-600">
              <Icon name="money" className="h-5 w-5" />
            </span>
            <h3 className="font-medium text-slate-800">
              {t(lang, "admin.persona.payroll.hub.svcTitle")}
            </h3>
          </div>
          <p className="text-xs text-slate-500 mt-2">
            {t(lang, "admin.persona.svc.subtitle")}
          </p>
        </Link>
      </div>
    </div>
  );
}
