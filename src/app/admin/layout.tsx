import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import LogoutButton from "./LogoutButton";
import HeaderBrand from "../HeaderBrand";
import LangToggle from "../LangToggle";
import Footer from "../Footer";
import Sidebar, { type SidebarSection } from "../components/Sidebar";
import AdminSidebarBrand from "./AdminSidebarBrand";

export const dynamic = "force-dynamic";

// Admin layout — collapsible left sidebar + topbar + main + footer.
// Sidebar groups all module pages (PERSONA, RESERVA) so the admin can jump
// between modules without a sub-nav. /admin/persona/legacy uses fixed-position
// iframe and overlays this layout.
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = getSessionUser();
  if (!user) return <>{children}</>;
  const lang = getLang();

  // Count of pending_review bookings on the active branch — surfaces as a
  // red badge next to the "การจอง" sidebar entry so admin notices new
  // customer requests without polling. Counts only today + future (past
  // pending bookings shouldn't pull attention; they were missed already).
  let pendingCount = 0;
  if (user.activeBranchId) {
    try {
      const db = getDb();
      const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const row = db.prepare(
        `SELECT COUNT(*) AS n FROM bookings
         WHERE branch_id = ? AND status = 'pending_review' AND booking_date >= ?`
      ).get(user.activeBranchId, todayBkk) as { n: number } | undefined;
      pendingCount = row?.n ?? 0;
    } catch {
      // schema not migrated yet (fresh deploy) → just show 0
      pendingCount = 0;
    }
  }

  // Sections are scoped to each module via pathPrefix — only the section
  // matching the current path is shown. The "Modules" section is always
  // visible so admin can switch back to the picker.
  const sections: SidebarSection[] = [
    {
      label: t(lang, "sidebar.section.modules"),
      items: [
        { href: "/admin", label: t(lang, "sidebar.modulePicker") },
        { href: "/admin/persona", label: "PERSONA" },
        { href: "/admin/reserva", label: "RESERVA" }
      ]
    },
    {
      label: "PERSONA",
      pathPrefix: "/admin/persona",
      items: [
        { href: "/admin/persona", label: t(lang, "admin.persona.nav.dashboard") },
        { href: "/admin/persona/employees", label: t(lang, "admin.persona.nav.employees") },
        { href: "/admin/persona/timesheets", label: t(lang, "admin.persona.nav.timesheets") },
        { href: "/admin/persona/payroll", label: t(lang, "admin.persona.nav.payroll") },
        { href: "/admin/persona/service-charge", label: t(lang, "admin.persona.nav.svc") },
        { href: "/admin/persona/leave", label: t(lang, "admin.persona.nav.leave") },
        { href: "/admin/persona/resignation", label: t(lang, "admin.persona.nav.resignation") },
        { href: "/admin/persona/holidays", label: t(lang, "admin.persona.nav.holidays") },
        { href: "/admin/persona/reports", label: t(lang, "admin.persona.nav.reports") },
        { href: "/admin/persona/messaging", label: t(lang, "admin.persona.nav.messaging") },
        { href: "/admin/persona/settings", label: t(lang, "admin.persona.nav.settings") },
        { href: "/admin/persona/legacy", label: t(lang, "admin.persona.nav.legacy"), legacy: true }
      ]
    },
    {
      label: "RESERVA",
      pathPrefix: "/admin/reserva",
      items: [
        { href: "/admin/reserva", label: t(lang, "admin.nav.overview") },
        {
          href: "/admin/reserva/bookings",
          label: t(lang, "admin.nav.bookings"),
          badge: pendingCount > 0 ? pendingCount : undefined
        },
        { href: "/admin/reserva/timetable", label: t(lang, "admin.reserva.nav.timetable") },
        { href: "/admin/reserva/scan", label: t(lang, "admin.reserva.nav.scan") },
        { href: "/admin/reserva/zones", label: t(lang, "admin.reserva.nav.zones") },
        { href: "/admin/reserva/floor-plan", label: t(lang, "admin.nav.floorPlan") },
        { href: "/admin/reserva/staff", label: t(lang, "admin.nav.users") },
        { href: "/admin/reserva/messaging", label: t(lang, "admin.reserva.nav.messaging") },
        { href: "/admin/reserva/settings", label: t(lang, "admin.nav.settings") },
        { href: "/admin/reserva/export", label: t(lang, "admin.nav.export") }
      ]
    }
  ];

  return (
    <div className="min-h-screen flex bg-slate-100">
      <Sidebar sections={sections} brand={<AdminSidebarBrand />} />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-ink-gradient text-white shadow-md">
          <div className="px-4 py-3 pl-16 flex items-center gap-3 flex-wrap">
            <div className="flex-1 min-w-0">
              <HeaderBrand role="admin" />
            </div>
            <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
              <span className="text-xs text-white/60 hidden sm:inline">
                {user.display_name} · {t(lang, "role.adminShort")}
              </span>
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
