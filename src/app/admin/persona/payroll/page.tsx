import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t, type Lang } from "@/lib/i18n";
import { formatLongDate } from "@/lib/time";
import PayPeriodPicker, { type ExistingPeriod } from "./PayPeriodPicker";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "เงินเดือน · PERSONA" };

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
  requireAdmin();
  const lang = getLang();
  const db = getDb();

  // Setup completeness
  const ptMissing = (db.prepare(`
    SELECT COUNT(*) AS n FROM users
    WHERE role = 'staff' AND employment_type = 'pt'
      AND (hourly_rate IS NULL OR hourly_rate = 0)
  `).get() as Counter).n;

  const ftMissing = (db.prepare(`
    SELECT COUNT(*) AS n FROM users
    WHERE role = 'staff' AND employment_type = 'ft'
      AND (monthly_salary IS NULL OR monthly_salary = 0 OR pay_cycle IS NULL)
  `).get() as Counter).n;

  const totalStaff = (db.prepare(`
    SELECT COUNT(*) AS n FROM users
    WHERE role = 'staff' AND employment_type IS NOT NULL
  `).get() as Counter).n;

  const settings = db.prepare(`
    SELECT ot_mode, ot_flat_per_15min, pt_default_hourly_rate
    FROM payroll_settings WHERE id = 1
  `).get() as Settings | undefined;

  // All existing periods (used by picker to mark "already created")
  const existing = db.prepare(`
    SELECT p.id, p.cycle, p.target, p.period_start, p.period_end, p.pay_date, p.status,
           (SELECT SUM(gross_pay) FROM payroll_lines WHERE period_id = p.id) AS total_gross,
           (SELECT SUM(net_pay)   FROM payroll_lines WHERE period_id = p.id) AS total_net,
           (SELECT COUNT(*)       FROM payroll_lines WHERE period_id = p.id) AS line_count
    FROM payroll_periods p
    ORDER BY p.period_end DESC, p.id DESC
  `).all() as ExistingPeriod[];

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
        </h1>
        <p className="text-sm text-slate-500">
          {t(lang, "admin.persona.payroll.hub.subtitle")}
        </p>
      </div>

      {/* Setup status */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="card">
          <div className="text-xs text-slate-500">
            {t(lang, "admin.persona.payroll.hub.totalStaff")}
          </div>
          <div className="text-2xl font-bold mt-1 text-slate-800">{totalStaff}</div>
        </div>
        <Link href="/admin/persona/employees" className="card hover:shadow-md transition block">
          <div className="text-xs text-slate-500">
            {t(lang, "admin.persona.payroll.hub.ptMissing")}
          </div>
          <div className={`text-2xl font-bold mt-1 ${ptMissing > 0 ? "text-amber-600" : "text-emerald-600"}`}>
            {ptMissing}
          </div>
          {ptMissing > 0 && (
            <div className="text-xs text-amber-700 mt-1">
              {t(lang, "admin.persona.payroll.hub.setupHint")} →
            </div>
          )}
        </Link>
        <Link href="/admin/persona/employees" className="card hover:shadow-md transition block">
          <div className="text-xs text-slate-500">
            {t(lang, "admin.persona.payroll.hub.ftMissing")}
          </div>
          <div className={`text-2xl font-bold mt-1 ${ftMissing > 0 ? "text-amber-600" : "text-emerald-600"}`}>
            {ftMissing}
          </div>
          {ftMissing > 0 && (
            <div className="text-xs text-amber-700 mt-1">
              {t(lang, "admin.persona.payroll.hub.setupHint")} →
            </div>
          )}
        </Link>
      </div>

      {/* Settings link (compact) */}
      <Link
        href="/admin/persona/payroll/settings"
        className="card border-l-4 border-sky-300 bg-sky-50 hover:shadow-md transition block"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-bold text-slate-800">
              {t(lang, "admin.persona.payroll.hub.settingsTitle")}
            </h2>
            <div className="text-xs text-slate-500 mt-1">
              {t(lang, "admin.persona.payroll.hub.currentOtMode")}: <span className="font-medium text-slate-700">{otModeLabel}</span>
              {settings && (
                <>
                  <span className="mx-2 text-slate-300">|</span>
                  {t(lang, "admin.persona.payroll.hub.ptDefaultRate")}: <span className="font-medium text-slate-700">{settings.pt_default_hourly_rate} ฿/ชม.</span>
                </>
              )}
            </div>
          </div>
          <span className="text-brand text-sm">→</span>
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
                  const targetLabel =
                    p.target === "pt" ? t(lang, "admin.persona.employees.employment.pt") :
                    p.target === "ft" ? t(lang, "admin.persona.employees.employment.ft") :
                    t(lang, "admin.persona.payroll.hub.targetAll");
                  const targetCls =
                    p.target === "pt" ? "bg-violet-100 text-violet-700" :
                    p.target === "ft" ? "bg-emerald-100 text-emerald-700" :
                    "bg-slate-100 text-slate-700";
                  return (
                    <tr key={p.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <span className={`text-xs px-1.5 py-0.5 rounded ${targetCls}`}>
                          {targetLabel}
                        </span>
                        <span className="ml-1 text-xs text-slate-500">
                          · {p.cycle === "weekly"
                              ? t(lang, "admin.persona.payroll.hub.weeklyShort")
                              : t(lang, "admin.persona.payroll.hub.monthlyShort")}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-slate-700">
                        {formatBkkDate(p.period_start, lang)} – {formatBkkDate(p.period_end, lang)}
                      </td>
                      <td className="py-2 pr-3 text-slate-700">{formatBkkDate(p.pay_date, lang)}</td>
                      <td className="py-2 pr-3 text-right text-slate-600">{p.line_count}</td>
                      <td className="py-2 pr-3 text-right">
                        {p.total_gross != null ? p.total_gross.toLocaleString() : "—"}
                      </td>
                      <td className="py-2 pr-3 text-right font-medium">
                        {p.total_net != null ? p.total_net.toLocaleString() : "—"}
                      </td>
                      <td className="py-2 pr-3">
                        <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${badge.cls}`}>
                          {badge.label}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-right">
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
          <h3 className="font-medium text-slate-700">
            {t(lang, "admin.persona.payroll.hub.payslipTitle")}
          </h3>
          <p className="text-xs text-slate-500 mt-1">
            🚧 {t(lang, "admin.persona.payroll.hub.phase3Note")}
          </p>
        </div>
        <Link href="/admin/persona/service-charge" className="card opacity-60 block hover:opacity-80 transition">
          <h3 className="font-medium text-slate-700">
            {t(lang, "admin.persona.payroll.hub.svcTitle")}
          </h3>
          <p className="text-xs text-slate-500 mt-1">
            🚧 {t(lang, "admin.persona.payroll.hub.phase4Note")}
          </p>
        </Link>
      </div>
    </div>
  );
}
