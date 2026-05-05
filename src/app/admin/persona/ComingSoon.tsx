import Link from "next/link";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";

export default function ComingSoon({ feature }: { feature: string }) {
  const lang = getLang();
  return (
    <div className="card text-center py-12 max-w-xl mx-auto">
      <div className="text-5xl mb-3">🚧</div>
      <h2 className="text-xl font-bold text-slate-800 mb-2">
        {t(lang, "admin.persona.comingSoon.title")} · {feature}
      </h2>
      <p className="text-sm text-slate-500 mb-6">
        {t(lang, "admin.persona.comingSoon.body")}
      </p>
      <Link href="/admin/persona/legacy" className="btn-primary inline-flex">
        {t(lang, "admin.persona.comingSoon.openLegacy")}
      </Link>
    </div>
  );
}
