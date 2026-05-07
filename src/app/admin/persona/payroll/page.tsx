import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "เงินเดือน · PERSONA" };

type Counter = { n: number };
type Settings = {
  ot_mode: "flat" | "legal";
  ot_flat_per_15min: number;
  pt_default_hourly_rate: number;
};

export default function PayrollHubPage() {
  requireAdmin();
  const lang = getLang();
  const db = getDb();

  // Setup completeness — count staff missing salary info
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

      {/* Settings link */}
      <Link
        href="/admin/persona/payroll/settings"
        className="card border-l-4 border-sky-300 bg-sky-50 hover:shadow-md transition block"
      >
        <h2 className="font-bold text-slate-800">
          {t(lang, "admin.persona.payroll.hub.settingsTitle")}
        </h2>
        <p className="text-sm text-slate-600 mt-1">
          {t(lang, "admin.persona.payroll.hub.settingsDesc")}
        </p>
        <div className="text-xs text-slate-500 mt-2">
          {t(lang, "admin.persona.payroll.hub.currentOtMode")}: <span className="font-medium text-slate-700">{otModeLabel}</span>
          {settings && (
            <>
              <span className="mx-2 text-slate-300">|</span>
              {t(lang, "admin.persona.payroll.hub.ptDefaultRate")}: <span className="font-medium text-slate-700">{settings.pt_default_hourly_rate} ฿/ชม.</span>
            </>
          )}
        </div>
      </Link>

      {/* C2 placeholder — payroll run (coming next deploy) */}
      <div className="card border-l-4 border-amber-300 bg-amber-50">
        <h2 className="font-bold text-slate-800">
          {t(lang, "admin.persona.payroll.hub.runTitle")}
        </h2>
        <p className="text-sm text-slate-600 mt-1">
          {t(lang, "admin.persona.payroll.hub.runDescPending")}
        </p>
        <p className="text-xs text-amber-700 mt-2">
          🚧 {t(lang, "admin.persona.payroll.hub.phase2Note")}
        </p>
      </div>

      {/* C3/C4 future */}
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
