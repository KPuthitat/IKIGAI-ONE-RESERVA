import { getSessionUser } from "@/lib/auth";
import { getDb, getSystemSettings } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import LogoutButton from "../admin/LogoutButton";
import HeaderBrand from "../HeaderBrand";
import LangToggle from "../LangToggle";
import Footer from "../Footer";
import ProgramInfo from "../components/ProgramInfo";
import AdminModeToggle from "../components/AdminModeToggle";
import Sidebar, { type SidebarSection } from "../components/Sidebar";
import StaffSidebarBrand from "./StaffSidebarBrand";
import TodaysBranchPill from "../TodaysBranchPill";
import HookFab from "../components/HookFab";
import ImpersonationBanner from "../components/ImpersonationBanner";
import MaintenanceBanner from "../components/MaintenanceBanner";
import { currentImpersonationContext } from "@/lib/impersonation";
import { nameWithPrefix } from "@/lib/name";

export const dynamic = "force-dynamic";

export default function StaffLayout({ children }: { children: React.ReactNode }) {
  const user = getSessionUser();
  if (!user) return <>{children}</>;
  const lang = getLang();

  // "Today's branch" — read from session activeBranchId, look up name.
  // Pill renders in the topbar so staff always sees which branch their
  // forms will write to. Click "เปลี่ยน" to swap branches mid-day.
  const activeBranch = user.activeBranchId
    ? user.branches.find((b) => b.id === user.activeBranchId) ?? null
    : null;
  const hasBranchChoice = user.branches.length > 1;

  // Badge: # of this user's edit requests with status='pending' or
  // recently rejected (so staff sees a count indicator on their
  // "คำขอแก้ไขรายการ" entry — mirror of admin's pending badge).
  // Wrapped in try/catch in case schema isn't migrated yet on a
  // first-deploy boot.
  let myPendingEditCount = 0;
  try {
    const row = getDb().prepare(
      `SELECT COUNT(*) AS n FROM shift_unlock_requests
       WHERE requested_by = ? AND status = 'pending'`
    ).get(user.id) as { n: number } | undefined;
    myPendingEditCount = row?.n ?? 0;
  } catch {
    myPendingEditCount = 0;
  }

  // Sections scoped to each module via pathPrefix.
  const sections: SidebarSection[] = [
    {
      label: t(lang, "sidebar.section.modules"),
      items: [
        { href: "/staff", label: t(lang, "sidebar.modulePicker") },
        { href: "/staff/persona", label: "PERSONA" },
        { href: "/staff/reserva", label: "RESERVA" },
        { href: "/staff/inventa", label: "INVENTA" }
      ]
    },
    {
      label: "INVENTA",
      pathPrefix: "/staff/inventa",
      // Ordered to match the real workflow: คลังสินค้า / สร้างคิวอาร์โค้ด
      // → เช็คสต๊อกรายสัปดาห์ → ใบสั่งซื้อ.
      items: [
        { href: "/staff/inventa", label: t(lang, "inv.nav.stock") },
        { href: "/staff/inventa/labels", label: t(lang, "inv.nav.qr") },
        { href: "/staff/inventa/count", label: t(lang, "inv.nav.count") },
        { href: "/staff/inventa/orders", label: t(lang, "inv.nav.orders") },
        // Settings is super_admin-only — hide the link from everyone
        // else (the page itself also enforces requireSuperAdmin).
        ...(user.role === "super_admin"
          ? [{ href: "/staff/inventa/settings", label: t(lang, "inv.nav.settings") }]
          : [])
      ]
    },
    {
      label: "PERSONA",
      pathPrefix: "/staff/persona",
      items: [
        { href: "/staff/persona", label: t(lang, "staff.nav.timeClock") },
        { href: "/staff/persona/calendar", label: t(lang, "staff.persona.nav.calendar") },
        { href: "/staff/persona/profile", label: t(lang, "staff.persona.nav.profile") },
        { href: "/staff/persona/discipline", label: t(lang, "staff.persona.nav.discipline") },
        { href: "/staff/persona/leave", label: t(lang, "staff.nav.leave") },
        { href: "/staff/persona/resignation", label: t(lang, "staff.nav.resignation") }
      ]
    },
    // Pre-shift items mirror the admin sidebar grouping. Each entry
    // is a separate route (not query-param) on the staff side because
    // each form has its own page-level lock + edit-request flow.
    {
      label: t(lang, "staff.nav.section.preShift"),
      pathPrefix: "/staff/persona",
      items: [
        { href: "/staff/persona/shift/open", label: t(lang, "staff.nav.preShiftChecklist") },
        { href: "/staff/persona/shift/readiness-1130", label: t(lang, "staff.nav.readiness1130") },
        { href: "/staff/persona/shift/readiness-1600", label: t(lang, "staff.nav.readiness1600") }
      ]
    },
    {
      label: t(lang, "staff.nav.section.postShift"),
      pathPrefix: "/staff/persona",
      items: [
        { href: "/staff/persona/shift/close", label: t(lang, "staff.nav.postShiftChecklist") }
      ]
    },
    {
      label: t(lang, "staff.nav.section.requests"),
      pathPrefix: "/staff/persona",
      items: [
        {
          href: "/staff/persona/shift/edit-requests",
          label: t(lang, "staff.nav.editRequests"),
          badge: myPendingEditCount > 0 ? myPendingEditCount : undefined
        },
        {
          href: "/staff/persona/time-certification",
          label: t(lang, "staff.persona.nav.timeCert")
        }
      ]
    },
    {
      label: "RESERVA",
      pathPrefix: "/staff/reserva",
      items: [
        { href: "/staff/reserva", label: t(lang, "staff.nav.bookings") },
        { href: "/staff/walk-in", label: t(lang, "staff.walkIn.title") }
      ]
    },
    {
      label: "",
      items: [
        { href: "/help", label: t(lang, "owl.help.menu") }
      ]
    }
  ];

  const impCtx = currentImpersonationContext();
  // Maintenance banner — renders ONLY when both fields are set:
  //   • maintenance_active = 1 (owner flipped the toggle ON)
  //   • maintenance_message non-empty (template text exists)
  // The two-field split lets the owner author the message ONCE then
  // just toggle on/off before/after each deploy. Wrapped in
  // try/catch in case the columns haven't migrated yet on first boot.
  let maintenanceMsg: string | null = null;
  try {
    const ss = getSystemSettings();
    if (ss.maintenance_active === 1 && ss.maintenance_message?.trim()) {
      maintenanceMsg = ss.maintenance_message.trim();
    }
  } catch {
    maintenanceMsg = null;
  }

  // Mobile-only sidebar footer — pill / username / lang / logout
  // moved here so the mobile topbar can stay just the brand.
  // Desktop keeps the topbar layout (see md:* classes below).
  // The STAFF / ADMIN switch is for anyone with admin powers — that
  // includes the super_admin (so the owner can pop into staff mode
  // to test the system) and any branch-admin (employee first, admin
  // rights second). Plain staff (no admin rights) get no switch.
  const isAdminUser = user.role === "super_admin"
                   || (user.role === "admin" && user.adminBranchIds.length > 0);
  const mobileSidebarFooter = (
    <div className="space-y-3">
      {/* STAFF / ADMIN switch — all breakpoints, admins only. */}
      {isAdminUser && <AdminModeToggle />}
      <div className="md:hidden space-y-3">
        {/* Branch pill moved into sidebar brand area 2026-05-25 —
            see Sidebar's brand prop below. Removes the duplicate
            that used to sit here in the mobile footer. */}
        <div className="text-xs text-white/60 truncate">
          {nameWithPrefix(user.title_prefix, user.display_name)}
        </div>
        <div className="flex items-center justify-between gap-2">
          <LangToggle variant="dark" />
          <LogoutButton />
        </div>
        {/* Program metadata — mobile only (full-width Footer hidden
            below md to declutter the page). */}
        <div className="border-t border-white/10 pt-3">
          <ProgramInfo />
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex bg-slate-100">
      {/* Maintenance banner rendered ABOVE the impersonation banner so
          the more urgent "system updating" message wins eye-catch when
          both are active simultaneously. */}
      {maintenanceMsg && <MaintenanceBanner message={maintenanceMsg} />}
      {impCtx && (
        <ImpersonationBanner
          impersonatorName={impCtx.impersonatorName}
          targetName={impCtx.targetName}
        />
      )}
      <Sidebar
        sections={sections}
        brand={
          <div className="space-y-2">
            <StaffSidebarBrand />
            {/* Branch pill under brand (2026-05-25 — same change as
                admin layout for consistency). Sidebar carries the
                branch context so staff can switch without scanning
                the topbar. */}
            {activeBranch && (
              <TodaysBranchPill
                branchName={activeBranch.name}
                hasChoice={hasBranchChoice}
                pickerPath="/staff/branch-picker"
              />
            )}
          </div>
        }
        footer={mobileSidebarFooter}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-ink-gradient text-white shadow-md">
          {/* Topbar — mobile shows only the brand. Branch pill,
              username chip, lang toggle, and logout move to the
              sidebar footer on small viewports (see md:* classes).
              See admin/layout.tsx for the same pattern. */}
          <div className="px-4 py-3 pl-16 flex items-center gap-2 sm:gap-3">
            <div className="flex-1 min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <HeaderBrand role="staff" />
              {/* Branch pill moved into sidebar brand 2026-05-25. */}
            </div>
            <div className="hidden md:block text-xs text-white/60 truncate max-w-[180px] flex-shrink-0">
              {nameWithPrefix(user.title_prefix, user.display_name)}
            </div>
            <div className="hidden md:flex items-center gap-2 flex-shrink-0">
              <LangToggle variant="dark" />
              <LogoutButton />
            </div>
          </div>
        </header>
        <main className="flex-1 w-full p-4 max-w-6xl mx-auto">{children}</main>
        {/* Desktop only — mobile shows this in the sidebar bottom. */}
        <div className="hidden md:block mt-auto">
          <Footer />
        </div>
      </div>
      <HookFab audience="staff" />
    </div>
  );
}
