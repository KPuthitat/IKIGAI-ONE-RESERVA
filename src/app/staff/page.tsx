import Link from "next/link";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Staff" };

export default function StaffHomePage({
  searchParams
}: { searchParams: { error?: string } }) {
  const user = requireUser();
  const lang = getLang();
  const showForbidden = searchParams.error === "forbidden";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">{t(lang, "portal.chooseModule")}</h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "portal.staffSubtitle", { name: user.display_name })}
        </p>
        {showForbidden && (
          <div className="mt-3 text-sm bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-3">
            {t(lang, "portal.notForbidden")}
          </div>
        )}
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <Link href="/staff/persona" className="card hover:shadow-2xl transition group block">
          <div className="text-[11px] tracking-[1px] text-slate-400 mb-1">{t(lang, "portal.label.module")}</div>
          <h2 className="text-2xl font-bold text-slate-800 group-hover:text-brand transition-colors">
            {t(lang, "portal.persona.title")}
          </h2>
          <p className="text-slate-500 text-sm mt-1">{t(lang, "portal.persona.staffDesc")}</p>
          <p className="mt-4 text-brand font-bold text-sm">{t(lang, "portal.openModule")}</p>
        </Link>

        <Link href="/staff/reserva" className="card hover:shadow-2xl transition group block">
          <div className="text-[11px] tracking-[1px] text-slate-400 mb-1">{t(lang, "portal.label.module")}</div>
          <h2 className="text-2xl font-bold text-slate-800 group-hover:text-brand transition-colors">
            {t(lang, "portal.reserva.title")}
          </h2>
          <p className="text-slate-500 text-sm mt-1">{t(lang, "portal.reserva.staffDesc")}</p>
          <p className="mt-4 text-brand font-bold text-sm">{t(lang, "portal.openModule")}</p>
        </Link>

        <Link href="/staff/inventa" className="card hover:shadow-2xl transition group block">
          <div className="text-[11px] tracking-[1px] text-slate-400 mb-1">{t(lang, "portal.label.module")}</div>
          <h2 className="text-2xl font-bold text-slate-800 group-hover:text-brand transition-colors">
            INVENTA
          </h2>
          <p className="text-slate-500 text-sm mt-1">{t(lang, "inv.module.desc")}</p>
          <p className="mt-4 text-brand font-bold text-sm">{t(lang, "portal.openModule")}</p>
        </Link>

        <Link href="/staff/ascenda" className="card hover:shadow-2xl transition group block opacity-80">
          <div className="flex items-center gap-2 mb-1">
            <div className="text-[11px] tracking-[1px] text-slate-400">{t(lang, "portal.label.module")}</div>
            <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700">
              {t(lang, "portal.label.comingSoon")}
            </span>
          </div>
          <h2 className="text-2xl font-bold text-slate-800 group-hover:text-brand transition-colors">
            {t(lang, "portal.ascenda.title")}
          </h2>
          <p className="text-slate-500 text-sm mt-1">{t(lang, "portal.ascenda.staffDesc")}</p>
          <p className="mt-4 text-slate-400 font-bold text-sm">{t(lang, "portal.previewModule")}</p>
        </Link>
      </div>
    </div>
  );
}
