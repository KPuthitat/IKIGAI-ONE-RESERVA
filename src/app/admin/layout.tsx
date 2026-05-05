import { getSessionUser } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import LogoutButton from "./LogoutButton";
import HeaderBrand from "../HeaderBrand";
import LangToggle from "../LangToggle";

export const dynamic = "force-dynamic";

// Admin top-level layout — ใช้สำหรับ /admin (module picker), /admin/persona, etc.
// /admin/reserva/* มี nested layout ของตัวเองเพิ่ม nav items ของ module
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = getSessionUser();
  if (!user) return <>{children}</>;
  const lang = getLang();

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="bg-ink-gradient text-white shadow-lg">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4 flex-wrap">
          <HeaderBrand role="admin" />
          <div className="ml-auto flex items-center gap-3 flex-wrap">
            <span className="text-xs text-white/60">
              {user.display_name} · {t(lang, "role.adminShort")}
            </span>
            <LangToggle variant="dark" />
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="max-w-6xl mx-auto p-4">{children}</main>
    </div>
  );
}
