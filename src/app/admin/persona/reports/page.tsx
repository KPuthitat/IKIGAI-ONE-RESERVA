import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "รายงาน · PERSONA" };

export default function ReportsHubPage() {
  requireAdmin();
  const lang = getLang();

  const reports: Array<{
    href: string;
    label: string;
    desc: string;
    accent: string;
  }> = [
    {
      href: "/admin/persona/reports/leave",
      label: t(lang, "admin.persona.reports.leave.title"),
      desc: t(lang, "admin.persona.reports.leave.desc"),
      accent: "border-amber-300 bg-amber-50"
    },
    {
      href: "/admin/persona/reports/hours",
      label: t(lang, "admin.persona.reports.hours.title"),
      desc: t(lang, "admin.persona.reports.hours.desc"),
      accent: "border-emerald-300 bg-emerald-50"
    },
    {
      href: "/admin/persona/reports/attendance",
      label: t(lang, "admin.persona.reports.attendance.title"),
      desc: t(lang, "admin.persona.reports.attendance.desc"),
      accent: "border-violet-300 bg-violet-50"
    },
    {
      href: "/admin/persona/reports/quota",
      label: t(lang, "admin.persona.reports.quota.title"),
      desc: t(lang, "admin.persona.reports.quota.desc"),
      accent: "border-sky-300 bg-sky-50"
    }
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.reports.hub.title")}
        </h1>
        <p className="text-sm text-slate-500">
          {t(lang, "admin.persona.reports.hub.subtitle")}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {reports.map((r) => (
          <Link
            key={r.href}
            href={r.href}
            className={`card border-l-4 ${r.accent} hover:shadow-md transition block`}
          >
            <h2 className="font-bold text-slate-800">{r.label}</h2>
            <p className="text-sm text-slate-600 mt-1">{r.desc}</p>
            <p className="text-brand text-sm font-medium mt-2">
              {t(lang, "admin.persona.reports.hub.openReport")} →
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
