import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "PERSONA · Admin" };

export default function AdminPersonaDashboard() {
  requireAdmin();
  const lang = getLang();

  // Stats = placeholder ตอนนี้ (ระบบยังไม่ได้ port ข้อมูลมา) — ค่อยเปิดทีหลัง
  const empStats = { pt: 0, ft: 0, ptActive: 0, ftActive: 0 };
  const pending = { leave: 0, corrections: 0 };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t(lang, "admin.persona.dashboard.title")}</h1>
        <p className="text-sm text-slate-500">{t(lang, "admin.persona.dashboard.subtitle")}</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Link href="/admin/persona/employees?tab=pt" className="card hover:shadow-md transition block">
          <div className="text-xs text-slate-500">{t(lang, "admin.persona.stat.pt")}</div>
          <div className="text-3xl font-bold text-slate-800 mt-1">{empStats.pt}</div>
          <div className="text-xs text-emerald-600 mt-1">
            {t(lang, "admin.persona.stat.activeBadge", { n: empStats.ptActive })}
          </div>
        </Link>

        <Link href="/admin/persona/employees?tab=ft" className="card hover:shadow-md transition block">
          <div className="text-xs text-slate-500">{t(lang, "admin.persona.stat.ft")}</div>
          <div className="text-3xl font-bold text-slate-800 mt-1">{empStats.ft}</div>
          <div className="text-xs text-emerald-600 mt-1">
            {t(lang, "admin.persona.stat.activeBadge", { n: empStats.ftActive })}
          </div>
        </Link>

        <Link href="/admin/persona/leave" className="card hover:shadow-md transition block">
          <div className="text-xs text-slate-500">{t(lang, "admin.persona.stat.pendingLeave")}</div>
          <div className={`text-3xl font-bold mt-1 ${pending.leave > 0 ? "text-amber-600" : "text-slate-300"}`}>
            {pending.leave}
          </div>
        </Link>

        <Link href="/admin/persona/timesheets" className="card hover:shadow-md transition block">
          <div className="text-xs text-slate-500">{t(lang, "admin.persona.stat.pendingCorrection")}</div>
          <div className={`text-3xl font-bold mt-1 ${pending.corrections > 0 ? "text-amber-600" : "text-slate-300"}`}>
            {pending.corrections}
          </div>
        </Link>
      </div>

      <div className="card">
        <h2 className="font-semibold mb-3">{t(lang, "admin.persona.legacy.title")}</h2>
        <p className="text-sm text-slate-600 mb-4">{t(lang, "admin.persona.legacy.note")}</p>
        <Link href="/admin/persona/legacy" className="btn-secondary inline-flex">
          {t(lang, "admin.persona.comingSoon.openLegacy")}
        </Link>
      </div>
    </div>
  );
}
