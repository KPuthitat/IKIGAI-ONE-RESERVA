import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Legacy · PERSONA · Admin" };

// /admin/persona/legacy — fullscreen iframe ของ Payroll เดิม
// ใช้สำหรับ feature ที่ยังไม่ port มา
export default function LegacyPayrollPage() {
  requireAdmin();
  const lang = getLang();
  return (
    <div className="fixed inset-0 bg-white flex flex-col z-40">
      <div className="bg-ink-gradient text-white px-4 py-2 flex items-center gap-2.5 text-xs flex-shrink-0">
        <Link href="/admin/persona" className="text-white/70 hover:text-white transition-colors">
          ← PERSONA
        </Link>
        <span className="text-white/30">|</span>
        <span className="brand-wordmark text-white text-sm">IKIGAI OS</span>
        <span className="text-white/40">•</span>
        <span className="text-white/85 font-light tracking-[1px] text-sm">PERSONA</span>
        <span className="text-white/40">/</span>
        <span className="text-amber-300 tracking-[1px]">legacy</span>
      </div>
      <iframe
        src="/payroll/portal"
        className="flex-1 w-full border-0 block bg-white"
        title="PERSONA Legacy"
      />
    </div>
  );
}
