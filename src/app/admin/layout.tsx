import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import LogoutButton from "./LogoutButton";

export const dynamic = "force-dynamic";

// Admin top-level layout — ใช้สำหรับ /admin (module picker), /admin/persona, etc.
// /admin/reserva/* มี nested layout ของตัวเองเพิ่ม nav items ของ module
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = getSessionUser();
  if (!user) return <>{children}</>;     // หน้าที่ไม่ต้องล็อกอินจะ render ได้ตรงๆ

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="bg-ink-gradient text-white shadow-lg">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4 flex-wrap">
          <div className="flex items-baseline gap-1.5">
            <Link href="/admin" className="brand-wordmark text-white text-lg">
              IKIGAI OS
            </Link>
            <span className="text-white/40 text-xs">/</span>
            <span className="text-white/80 text-xs tracking-[1px] font-bold">ADMIN</span>
          </div>
          <div className="ml-auto flex items-center gap-3 flex-wrap">
            <span className="text-xs text-white/60">
              {user.display_name} · ผู้ดูแล
            </span>
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="max-w-6xl mx-auto p-4">{children}</main>
    </div>
  );
}
