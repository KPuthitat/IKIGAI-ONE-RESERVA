import { getSessionUser } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import LogoutButton from "./LogoutButton";
import HeaderBrand from "../HeaderBrand";
import LangToggle from "../LangToggle";
import Footer from "../Footer";

export const dynamic = "force-dynamic";

// Admin top-level layout — ใช้สำหรับ /admin (module picker), /admin/persona, etc.
// /admin/reserva/* มี nested layout ของตัวเองเพิ่ม nav items ของ module
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = getSessionUser();
  if (!user) return <>{children}</>;
  const lang = getLang();

  return (
    <div className="min-h-screen flex flex-col bg-slate-100">
      <header className="bg-ink-gradient text-white shadow-lg">
        <div className="max-w-6xl mx-auto px-4 py-3
          flex flex-col gap-2
          sm:grid sm:grid-cols-[1fr_auto_1fr] sm:items-center sm:gap-2">
          <div className="hidden sm:block"></div>
          <div className="flex justify-center"><HeaderBrand role="admin" /></div>
          <div className="flex items-center justify-center sm:justify-end gap-2 sm:gap-3 flex-wrap">
            <span className="text-xs text-white/60">
              {user.display_name} · {t(lang, "role.adminShort")}
            </span>
            <LangToggle variant="dark" />
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="flex-1 max-w-6xl mx-auto w-full p-4">{children}</main>
      <Footer />
    </div>
  );
}
