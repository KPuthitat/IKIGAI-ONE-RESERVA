import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
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
import { currentImpersonationContext } from "@/lib/impersonation";

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
      items: [
        { href: "/staff/inventa", label: "คลังสินค้า" },
        { href: "/staff/inventa/orders", label: "ใบสั่งซื้อ" },
        { href: "/staff/inventa/grid", label: "ผังกริด (หาตำแหน่ง)" },
        { href: "/staff/inventa/labels", label: "พิมพ์ QR ติดชั้น" },
        { href: "/staff/inventa/count", label: "เช็คสต๊อกรายสัปดาห์" },
        // Settings is super_admin-only — hide the link from everyone
        // else (the page itself also enforces requireSuperAdmin).
        ...(user.role === "super_admin"
          ? [{ href: "/staff/inventa/settings", label: "ตั้งค่า" }]
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
        { href: "/staff/reserva", label: t(lang, "staff.nav.bookings") }
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

  // Mobile-only sidebar footer — pill / username / lang / logout
  // moved here so the mobile topbar can stay just the brand.
  // Desktop keeps the topbar layout (see md:* classes below).
  // The STAFF / ADMIN switch is for people who are an employee FIRST
  // but also hold admin rights — i.e. role 'admin' with at least one
  // branch they administer. They land in staff mode and flip this to
  // open the admin console. Plain staff (no admin rights) get no
  // switch. super_admin is the top-level settings account and never
  // works as staff, so it gets no switch either.
  const isAdminUser = user.role === "admin" && user.adminBranchIds.length > 0;
  const mobileSidebarFooter = (
    <div className="space-y-3">
      {/* STAFF / ADMIN switch — all breakpoints, admins only. */}
      {isAdminUser && <AdminModeToggle />}
      <div className="md:hidden space-y-3">
        {activeBranch && (
          <div className="flex justify-start">
            <TodaysBranchPill
              branchName={activeBranch.name}
              hasChoice={hasBranchChoice}
              pickerPath="/staff/branch-picker"
            />
          </div>
        )}
        <div className="text-xs text-white/60 truncate">
          {user.display_name}
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
      {impCtx && (
        <ImpersonationBanner
          impersonatorName={impCtx.impersonatorName}
          targetName={impCtx.targetName}
        />
      )}
      <Sidebar
        sections={sections}
        brand={<StaffSidebarBrand />}
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
              {activeBranch && (
                <div className="hidden md:block">
                  <TodaysBranchPill
                    branchName={activeBranch.name}
                    hasChoice={hasBranchChoice}
                    pickerPath="/staff/branch-picker"
                  />
                </div>
              )}
            </div>
            <div className="hidden md:block text-xs text-white/60 truncate max-w-[180px] flex-shrink-0">
              {user.display_name}
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
