import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "PERSONA · Admin" };

// /admin/persona — fullscreen iframe ของ Payroll
// ใช้ position: fixed ให้ escape max-w-6xl ของ /admin/layout · มี top bar บางๆ สำหรับกลับ
export default function AdminPersonaPage() {
  requireAdmin();
  return (
    <div className="fixed inset-0 bg-white flex flex-col z-40">
      {/* Top bar บางๆ — IKIGAI OS branding + back button */}
      <div className="bg-ink-gradient text-white px-4 py-2 flex items-center gap-2.5 text-xs flex-shrink-0">
        <Link href="/admin" className="text-white/70 hover:text-white transition-colors">
          ← Admin
        </Link>
        <span className="text-white/30">|</span>
        <span className="brand-wordmark text-white text-sm">IKIGAI OS</span>
        <span className="text-white/40">•</span>
        <span className="text-white/85 font-light tracking-[1px] text-sm">PERSONA</span>
        <span className="text-white/40">/</span>
        <span className="text-white/60 tracking-[1px]">admin</span>
      </div>

      {/* iframe เต็มที่เหลือ */}
      <iframe
        src="/payroll/portal"
        className="flex-1 w-full border-0 block bg-white"
        title="PERSONA"
      />
    </div>
  );
}
