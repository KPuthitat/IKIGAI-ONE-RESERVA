import Link from "next/link";
import type { Metadata } from "next";
import { requirePayrollAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import PayrollSettingsClient, { type PayrollSettings } from "./PayrollSettingsClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "ตั้งค่าค่าตอบแทน · PERSONA" };

export default function PayrollSettingsPage() {
  requirePayrollAccess();
  const lang = getLang();
  const db = getDb();

  const settings = db.prepare(`
    SELECT
      ot_mode, ot_flat_per_15min,
      break_threshold_minutes, break_deduction_minutes,
      long_shift_threshold_minutes, long_shift_break_minutes,
      sso_rate, sso_cap, pt_default_hourly_rate, wht_rate
    FROM payroll_settings WHERE id = 1
  `).get() as PayrollSettings;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/admin/persona/payroll" className="text-sm text-slate-500 hover:text-brand">
          ← {t(lang, "admin.persona.payroll.backToHub")}
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.payroll.settings.title")}
        </h1>
        <p className="text-sm text-slate-500">
          {t(lang, "admin.persona.payroll.settings.subtitle")}
        </p>
      </div>
      <PayrollSettingsClient initial={settings} lang={lang} />
    </div>
  );
}
