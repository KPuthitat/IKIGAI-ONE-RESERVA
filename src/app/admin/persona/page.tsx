import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "PERSONA · Admin" };

export default function AdminPersonaPage() {
  requireAdmin();
  const lang = getLang();
  return (
    <div className="fixed inset-0 bg-white flex flex-col z-40">
      <div className="bg-ink-gradient text-white px-4 py-2 flex items-center gap-2.5 text-xs flex-shrink-0">
        <Link href="/admin" className="text-white/70 hover:text-white transition-colors">
          ← {t(lang, "role.adminShort")}
        </Link>
        <span className="text-white/30">|</span>
        <span className="brand-wordmark text-white text-sm">IKIGAI OS</span>
        <span className="text-white/40">•</span>
        <span className="text-white/85 font-light tracking-[1px] text-sm">PERSONA</span>
        <span className="text-white/40">/</span>
        <span className="text-white/60 tracking-[1px]">admin</span>
      </div>

      <iframe
        src="/payroll/portal"
        className="flex-1 w-full border-0 block bg-white"
        title="PERSONA"
      />
    </div>
  );
}
