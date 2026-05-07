import { getSessionUser } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import LogoutButton from "../admin/LogoutButton";
import HeaderBrand from "../HeaderBrand";
import LangToggle from "../LangToggle";
import Footer from "../Footer";
import Sidebar, { type SidebarSection } from "../components/Sidebar";
import StaffSidebarBrand from "./StaffSidebarBrand";

export const dynamic = "force-dynamic";

export default function StaffLayout({ children }: { children: React.ReactNode }) {
  const user = getSessionUser();
  if (!user) return <>{children}</>;
  const lang = getLang();

  const sections: SidebarSection[] = [
    {
      label: t(lang, "sidebar.section.modules"),
      items: [
        { href: "/staff", label: t(lang, "sidebar.modulePicker") }
      ]
    },
    {
      label: "PERSONA",
      items: [
        { href: "/staff/persona", label: t(lang, "staff.nav.timeClock") },
        { href: "/staff/persona/leave", label: t(lang, "staff.nav.leave") },
        { href: "/staff/persona/resignation", label: t(lang, "staff.nav.resignation") }
      ]
    },
    {
      label: "RESERVA",
      items: [
        { href: "/staff/reserva", label: t(lang, "staff.nav.bookings") }
      ]
    }
  ];

  return (
    <div className="min-h-screen flex bg-slate-100">
      <Sidebar sections={sections} brand={<StaffSidebarBrand />} />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-ink-gradient text-white shadow-md">
          <div className="px-4 py-3 pl-16 flex items-center gap-3 flex-wrap">
            <div className="flex-1 min-w-0">
              <HeaderBrand role="staff" />
            </div>
            <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
              <span className="text-xs text-white/60 hidden sm:inline">{user.display_name}</span>
              <LangToggle variant="dark" />
              <LogoutButton />
            </div>
          </div>
        </header>
        <main className="flex-1 w-full p-4 max-w-6xl mx-auto">{children}</main>
        <Footer />
      </div>
    </div>
  );
}
