import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ASCENDA" };

export default function StaffAscendaPage() {
  requireUser();
  const lang = getLang();

  return (
    <div className="space-y-4">
      <div>
        <Link href="/staff" className="text-sm text-slate-500 hover:text-brand">
          {t(lang, "common.backToPortal")}
        </Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-2">ASCENDA</h1>
        <p className="text-sm text-slate-500">{t(lang, "ascenda.subtitle")}</p>
      </div>

      <div className="card text-center py-16 max-w-xl mx-auto">
        <h2 className="text-xl font-bold text-slate-800 mb-2">
          {t(lang, "ascenda.comingSoonTitle")}
        </h2>
        <p className="text-sm text-slate-500 max-w-md mx-auto">
          {t(lang, "ascenda.comingSoonBody")}
        </p>
      </div>
    </div>
  );
}
