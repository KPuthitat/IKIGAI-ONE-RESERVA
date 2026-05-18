import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "ADMIN" };

export default function AdminHomePage() {
  requireAdmin();
  const lang = getLang();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">{t(lang, "portal.chooseModule")}</h1>
        <p className="text-sm text-slate-500 mt-1">{t(lang, "portal.adminSubtitle")}</p>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <Link href="/admin/persona" className="card hover:shadow-2xl transition group block">
          <div className="text-[11px] tracking-[1px] text-slate-400 mb-1">{t(lang, "portal.label.module")}</div>
          <h2 className="text-2xl font-bold text-slate-800 group-hover:text-brand transition-colors">
            {t(lang, "portal.persona.title")}
          </h2>
          <p className="text-slate-500 text-sm mt-1">{t(lang, "portal.persona.adminDesc")}</p>
          <p className="mt-4 text-brand font-bold text-sm">{t(lang, "portal.openBackend")}</p>
        </Link>

        <Link href="/admin/reserva" className="card hover:shadow-2xl transition group block">
          <div className="text-[11px] tracking-[1px] text-slate-400 mb-1">{t(lang, "portal.label.module")}</div>
          <h2 className="text-2xl font-bold text-slate-800 group-hover:text-brand transition-colors">
            {t(lang, "portal.reserva.title")}
          </h2>
          <p className="text-slate-500 text-sm mt-1">{t(lang, "portal.reserva.adminDesc")}</p>
          <p className="mt-4 text-brand font-bold text-sm">{t(lang, "portal.openBackend")}</p>
        </Link>

        <Link href="/staff/inventa" className="card hover:shadow-2xl transition group block">
          <div className="text-[11px] tracking-[1px] text-slate-400 mb-1">{t(lang, "portal.label.module")}</div>
          <h2 className="text-2xl font-bold text-slate-800 group-hover:text-brand transition-colors">
            INVENTA
          </h2>
          <p className="text-slate-500 text-sm mt-1">ระบบนับสต๊อกคลินิก — ยา/อุปกรณ์ ตำแหน่ง grid + จุดสั่งซื้อ</p>
          <p className="mt-4 text-brand font-bold text-sm">{t(lang, "portal.openModule")}</p>
        </Link>

        <Link href="/admin/ascenda" className="card hover:shadow-2xl transition group block opacity-80">
          <div className="flex items-center gap-2 mb-1">
            <div className="text-[11px] tracking-[1px] text-slate-400">{t(lang, "portal.label.module")}</div>
            <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700">
              {t(lang, "portal.label.comingSoon")}
            </span>
          </div>
          <h2 className="text-2xl font-bold text-slate-800 group-hover:text-brand transition-colors">
            {t(lang, "portal.ascenda.title")}
          </h2>
          <p className="text-slate-500 text-sm mt-1">{t(lang, "portal.ascenda.adminDesc")}</p>
          <p className="mt-4 text-slate-400 font-bold text-sm">{t(lang, "portal.previewModule")}</p>
        </Link>
      </div>
    </div>
  );
}
