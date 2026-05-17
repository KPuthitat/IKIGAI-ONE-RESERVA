import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { autoExpireStaleBookings } from "@/lib/stale-bookings";
import LogoutButton from "./LogoutButton";
import HeaderBrand from "../HeaderBrand";
import LangToggle from "../LangToggle";
import Footer from "../Footer";
import Sidebar, { type SidebarSection } from "../components/Sidebar";
import ProgramInfo from "../components/ProgramInfo";
import AdminModeToggle from "../components/AdminModeToggle";
import AdminSidebarBrand from "./AdminSidebarBrand";
import TodaysBranchPill from "../TodaysBranchPill";
import HookFab from "../components/HookFab";
import ImpersonationBanner from "../components/ImpersonationBanner";
import { currentImpersonationContext } from "@/lib/impersonation";

export const dynamic = "force-dynamic";

// Admin layout — collapsible left sidebar + topbar + main + footer.
// Sidebar groups all module pages (PERSONA, RESERVA) so the admin can jump
// between modules without a sub-nav. /admin/persona/legacy uses fixed-position
// iframe and overlays this layout.
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = getSessionUser();
  if (!user) return <>{children}</>;
  const lang = getLang();

  // Today's-branch pill in the topbar — same pattern staff has, so
  // admin can swap branches from any page (was a per-module dropdown
  // until 2026-05). The pill links to /admin/branch-picker?next=...
  // and the picker writes session.active_branch_id, then bounces back.
  const activeBranch = user.activeBranchId
    ? user.branches.find((b) => b.id === user.activeBranchId) ?? null
    : null;
  const hasBranchChoice = user.branches.length > 1;

  // Count of pending_review bookings on the active branch — surfaces as a
  // red badge next to the "การจอง" sidebar entry so admin notices new
  // customer requests without polling.
  let pendingCount = 0;
  // Count of pending shift_open unlock requests on the active branch —
  // similar badge next to the "เช็คลิสต์ก่อนเริ่มงาน" admin entry so
  // admin acts on staff edit-requests without polling.
  let unlockPendingCount = 0;
  if (user.activeBranchId) {
    try {
      // Auto-expire stale rows first so the count reflects only bookings
      // that still need action (past-cutoff pending → cancelled, removed
      // from the count).
      autoExpireStaleBookings();
      const db = getDb();
      const row = db.prepare(
        `SELECT COUNT(*) AS n FROM bookings
         WHERE branch_id = ? AND status = 'pending_review'`
      ).get(user.activeBranchId) as { n: number } | undefined;
      pendingCount = row?.n ?? 0;
      const unlockRow = db.prepare(
        `SELECT COUNT(*) AS n FROM shift_unlock_requests r
         JOIN daily_reports dr ON dr.id = r.daily_report_id
         WHERE r.status = 'pending' AND dr.branch_id = ?`
      ).get(user.activeBranchId) as { n: number } | undefined;
      unlockPendingCount = unlockRow?.n ?? 0;
    } catch {
      // schema not migrated yet (fresh deploy) → just show 0
      pendingCount = 0;
      unlockPendingCount = 0;
    }
  }

  // Sections are scoped to each module via pathPrefix — only the section
  // matching the current path is shown. The "Modules" section is always
  // visible so admin can switch back to the picker.
  const isSuperAdmin = user.role === "super_admin";

  const sections: SidebarSection[] = [
    {
      label: t(lang, "sidebar.section.modules"),
      items: [
        { href: "/admin", label: t(lang, "sidebar.modulePicker") },
        { href: "/admin/persona", label: "PERSONA" },
        { href: "/admin/reserva", label: "RESERVA" },
        // INVENTA lives under /staff (clinic staff tool; admins are
        // employees too). Surface it here so it's reachable from the
        // admin console as well. super_admin also gets the settings link.
        { href: "/staff/inventa", label: "INVENTA" },
        ...(isSuperAdmin
          ? [{ href: "/staff/inventa/settings", label: "INVENTA · ตั้งค่า" }]
          : []),
        // System-wide entries — only super_admin can manage these,
        // so hide them from regular admins to keep the sidebar clean.
        // The pages still enforce requireSuperAdmin() server-side as
        // a belt-and-braces second check.
        ...(isSuperAdmin ? [
          { href: "/admin/system-settings", label: t(lang, "admin.systemSettings.title") },
          { href: "/admin/companies", label: t(lang, "admin.companies.title") }
        ] : []),
        { href: "/help", label: t(lang, "owl.help.menu") }
      ]
    },
    {
      label: "PERSONA",
      pathPrefix: "/admin/persona",
      items: [
        { href: "/admin/persona", label: t(lang, "admin.persona.nav.dashboard") },
        { href: "/admin/persona/employees", label: t(lang, "admin.persona.nav.employees") },
        { href: "/admin/persona/roster", label: t(lang, "admin.persona.nav.roster") },
        { href: "/admin/persona/timesheets", label: t(lang, "admin.persona.nav.timesheets") },
        { href: "/admin/persona/timesheets/monthly", label: t(lang, "admin.persona.nav.monthlyTimesheets") },
        { href: "/admin/persona/payroll", label: t(lang, "admin.persona.nav.payroll") },
        { href: "/admin/persona/service-charge", label: t(lang, "admin.persona.nav.svc") },
        { href: "/admin/persona/leave", label: t(lang, "admin.persona.nav.leave") },
        { href: "/admin/persona/resignation", label: t(lang, "admin.persona.nav.resignation") },
        { href: "/admin/persona/holidays", label: t(lang, "admin.persona.nav.holidays") },
        { href: "/admin/persona/discipline", label: t(lang, "admin.persona.nav.discipline") },
        { href: "/admin/persona/health", label: t(lang, "admin.persona.nav.health") }
      ]
    },
    // Pre-shift items — admin configures the checklist for each
    // report type. Same /admin/persona/checklist editor handles all
    // four; the page reads `?type=` to know which list to show/edit.
    {
      label: t(lang, "admin.persona.nav.section.preShift"),
      pathPrefix: "/admin/persona",
      items: [
        {
          href: "/admin/persona/checklist?type=shift_open",
          label: t(lang, "admin.persona.nav.preShiftChecklist")
        },
        {
          href: "/admin/persona/checklist?type=readiness_1130",
          label: t(lang, "admin.persona.nav.readiness1130")
        },
        {
          href: "/admin/persona/checklist?type=readiness_1600",
          label: t(lang, "admin.persona.nav.readiness1600")
        }
      ]
    },
    // Post-shift items.
    {
      label: t(lang, "admin.persona.nav.section.postShift"),
      pathPrefix: "/admin/persona",
      items: [
        {
          href: "/admin/persona/checklist?type=shift_close",
          label: t(lang, "admin.persona.nav.postShiftChecklist")
        }
      ]
    },
    // Edit-request inbox — admin reviews staff requests to redo a
    // submitted checklist. Badge mirrors what shift-reports page
    // queries so the count is accurate without polling.
    {
      label: t(lang, "admin.persona.nav.section.requests"),
      pathPrefix: "/admin/persona",
      items: [
        {
          href: "/admin/persona/shift-reports",
          label: t(lang, "admin.persona.nav.shiftReports"),
          badge: unlockPendingCount > 0 ? unlockPendingCount : undefined
        },
        {
          href: "/admin/persona/time-certifications",
          label: t(lang, "admin.persona.nav.timeCert")
        }
      ]
    },
    // Tail items kept under "PERSONA" header again so they sit at
    // the bottom of the persona section.
    {
      label: "",  // empty label = no header
      pathPrefix: "/admin/persona",
      items: [
        { href: "/admin/persona/reports", label: t(lang, "admin.persona.nav.reports") },
        { href: "/admin/persona/messaging", label: t(lang, "admin.persona.nav.messaging") },
        { href: "/admin/persona/settings", label: t(lang, "admin.persona.nav.settings") }
        // Legacy iframe link removed 2026-05-13 — all features are
        // now native PERSONA pages. /admin/persona/legacy still
        // resolves by URL for ~2 weeks during transition, can be
        // deleted afterwards.
      ]
    },
    {
      label: "RESERVA",
      pathPrefix: "/admin/reserva",
      items: [
        { href: "/admin/reserva", label: t(lang, "admin.nav.overview") },
        {
          href: "/admin/reserva/pending",
          label: t(lang, "admin.nav.pendingReview"),
          badge: pendingCount > 0 ? pendingCount : undefined
        },
        { href: "/admin/reserva/bookings", label: t(lang, "admin.nav.bookings") },
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

  // Impersonation banner — only renders when super_admin/admin has
  // started a "log in as" session for debugging. Sticky orange
  // banner at the top reminds them they're viewing another user's
  // view + provides a one-click way back to their own session.
  const impCtx = currentImpersonationContext();

  // Mobile-only footer for the sidebar: branch pill, lang toggle,
  // logout. Desktop keeps these in the topbar (md+). On mobile the
  // topbar reduces to just the program name so the row never wraps
  // or collides with the menu button, and these controls live one
  // tap away inside the slide-in sidebar instead.
  const mobileSidebarFooter = (
    <div className="space-y-3">
      {/* STAFF / ADMIN switch — only for branch admins (employee +
          admin rights). super_admin is the settings-only top account
          and never switches to staff, so it gets no toggle. */}
      {user.role === "admin" && user.adminBranchIds.length > 0 && (
        <AdminModeToggle />
      )}
      <div className="md:hidden space-y-3">
        {activeBranch && (
          <div className="flex justify-start">
            <TodaysBranchPill
              branchName={activeBranch.name}
              hasChoice={hasBranchChoice}
              pickerPath="/admin/branch-picker"
            />
          </div>
        )}
        <div className="text-xs text-white/60 truncate">
          {user.display_name} · {t(lang, "role.adminShort")}
        </div>
        <div className="flex items-center justify-between gap-2">
          <LangToggle variant="dark" />
          <LogoutButton />
        </div>
        {/* Program metadata — mobile only (full-width Footer hidden
            below md to keep the cramped main content area clean). */}
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
        brand={<AdminSidebarBrand />}
        footer={mobileSidebarFooter}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-ink-gradient text-white shadow-md">
          {/* Topbar — single row.
              Mobile: brand only. The branch pill, language toggle,
                and logout live in the sidebar footer instead, so
                the row stays compact next to the hamburger menu.
              Desktop (md+): brand + branch pill on the left,
                username chip + lang toggle + logout on the right
                (the classic layout). */}
          <div className="px-4 py-3 pl-16 flex items-center gap-2 sm:gap-3">
            <div className="flex-1 min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <HeaderBrand role="admin" />
              {activeBranch && (
                <div className="hidden md:block">
                  <TodaysBranchPill
                    branchName={activeBranch.name}
                    hasChoice={hasBranchChoice}
                    pickerPath="/admin/branch-picker"
                  />
                </div>
              )}
            </div>
            <div className="hidden md:block text-xs text-white/60 truncate max-w-[200px] flex-shrink-0">
              {user.display_name} · {t(lang, "role.adminShort")}
            </div>
            <div className="hidden md:flex items-center gap-2 flex-shrink-0">
              <LangToggle variant="dark" />
              <LogoutButton />
            </div>
          </div>
        </header>
        <main className="flex-1 w-full p-4 max-w-6xl mx-auto">{children}</main>
        {/* Desktop only — on mobile this info moves into the sidebar
            bottom (see mobileSidebarFooter) so the page isn't crowded. */}
        <div className="hidden md:block mt-auto">
          <Footer />
        </div>
      </div>
      <HookFab audience="admin" />
    </div>
  );
}
