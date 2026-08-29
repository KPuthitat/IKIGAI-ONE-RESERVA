import { cookies } from "next/headers";
import { getSessionUser } from "@/lib/auth";
import { getDb, getSystemSettings } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import LogoutButton from "../admin/LogoutButton";
import HeaderBrand from "../HeaderBrand";
import LangToggle from "../LangToggle";
import Footer from "../Footer";
import AdminModeToggle from "../components/AdminModeToggle";
import { type SidebarSection } from "../components/Sidebar";
import ModuleTabs, { type ModuleTab } from "../components/ModuleTabs";
import ModuleSubnav from "../components/ModuleSubnav";
import TodaysBranchPill from "../TodaysBranchPill";
import HookFab from "../components/HookFab";
import RefreshButton from "../components/RefreshButton";
import ImpersonationBanner from "../components/ImpersonationBanner";
import MaintenanceBanner from "../components/MaintenanceBanner";
import { currentImpersonationContext } from "@/lib/impersonation";
import { nameWithPrefix } from "@/lib/name";
import { getMyEnrollment, type MjActor } from "@/lib/mounjaro-db";

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

  // Mounjaro Wellness — the health menu appears ONLY for staff who have an
  // enrollment record (privacy: non-enrolled employees never see it; an
  // erased enrollment returns null → hidden). Wrapped in try/catch in case
  // the table isn't migrated yet on a first-deploy boot.
  let mjEnrolled = false;
  try { mjEnrolled = !!getMyEnrollment(user as MjActor); } catch { mjEnrolled = false; }

  // Persisted view intent (owner 2026-06-08). INVENTA lives under /staff,
  // so an admin who is in "admin view" and opens INVENTA used to fall into
  // staff view with no easy way back. The os_view cookie remembers the
  // intent — when it's "admin", keep the top-level module links pointing at
  // /admin so the admin can jump back to any console page (never stranded).
  // Default (no cookie) = staff, preserving the "admin is an employee
  // first" behaviour. INVENTA itself stays under /staff (that's its home).
  const isAdminUser = user.role === "super_admin"
    || (user.role === "admin" && user.adminBranchIds.length > 0)
    || user.permissions.length > 0;
  // Home mode by role (owner 2026-06-11): super_admin lands in admin view,
  // everyone else in staff view. The os_view cookie overrides once the user
  // deliberately switches (PIN-gated for the non-default direction).
  const defaultView: "admin" | "staff" = user.role === "super_admin" ? "admin" : "staff";
  const viewCookie = cookies().get("os_view")?.value;
  const effectiveView: "admin" | "staff" =
    viewCookie === "admin" || viewCookie === "staff" ? viewCookie : defaultView;
  const adminView = isAdminUser && effectiveView === "admin";
  const modBase = adminView ? "/admin" : "/staff";

  // Branch-gate (owner 2026-06-11): block opening a module until a branch is
  // selected — when none is set, module links route through the branch picker
  // (?next=destination). The picker auto-skips for single-branch users.
  const needBranch = !user.activeBranchId;
  const gate = (href: string) =>
    needBranch ? `${modBase}/branch-picker?next=${encodeURIComponent(href)}` : href;
  // Sections scoped to each module via pathPrefix.
  const sections: SidebarSection[] = [
    {
      label: t(lang, "sidebar.section.modules"),
      items: [
        { href: adminView ? "/admin" : "/staff", label: t(lang, "sidebar.modulePicker") },
        { href: gate(`${modBase}/persona`), label: "PERSONA" },
        { href: gate(`${modBase}/reserva`), label: "RESERVA" },
        { href: gate("/staff/inventa"), label: "INVENTA" }
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
        { href: "/staff/inventa/orders/list", label: t(lang, "inv.nav.ordersList") },
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
        { href: "/staff/persona/mealpass", label: "MEALPASS · อาหาร/เครื่องดื่ม" },
        { href: "/staff/persona/profile", label: t(lang, "staff.persona.nav.profile") },
        { href: "/staff/persona/discipline", label: t(lang, "staff.persona.nav.discipline") },
        { href: "/staff/persona/leave", label: t(lang, "staff.nav.leave") },
        { href: "/staff/persona/shift-request", label: "คำขอเปลี่ยนเวลางาน" },
        { href: "/staff/persona/shift-swap", label: "สลับกะ" },
        { href: "/staff/persona/time-certification", label: t(lang, "staff.persona.nav.timeCert") },
        {
          href: "/staff/persona/shift/edit-requests",
          label: t(lang, "staff.nav.editRequests"),
          badge: myPendingEditCount > 0 ? myPendingEditCount : undefined
        },
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
      label: "RESERVA",
      pathPrefix: "/staff/reserva",
      items: [
        { href: "/staff/reserva", label: t(lang, "staff.nav.bookings") },
        { href: "/staff/walk-in", label: t(lang, "staff.walkIn.title") }
      ]
    },
    // สุขภาพพนักงาน — "ผลตรวจสุขภาพ" เห็นได้ทุกคน (ผลตรวจของตัวเอง);
    // "โครงการควบคุมน้ำหนัก" เห็นเฉพาะคนที่อยู่ในโครงการ (privacy).
    {
      label: "สุขภาพพนักงาน",
      items: [
        { href: "/staff/health/exams", label: "ผลตรวจสุขภาพ" },
        ...(mjEnrolled
          ? [{ href: "/staff/health/mounjaro", label: "โครงการควบคุมน้ำหนัก" }]
          : [])
      ]
    },
    {
      label: "",
      items: [
        { href: "/help", label: t(lang, "owl.help.menu") }
      ]
    }
  ];

  // Redesign 2026-08: module switcher → top tab bar; the remaining
  // pathPrefix-scoped sections (+ always-visible health / help) become the
  // contextual sub-nav. `base` is the clean module path for active
  // detection; `href` may be a branch-picker gate URL. In admin-view the
  // module links point at /admin (modBase) so an admin is never stranded.
  const homeBase = adminView ? "/admin" : "/staff";
  const moduleTabs: ModuleTab[] = [
    { key: "home", label: t(lang, "sidebar.modulePicker"), href: homeBase, base: homeBase, exact: true },
    { key: "persona", label: "PERSONA", href: gate(`${modBase}/persona`), base: `${modBase}/persona` },
    { key: "reserva", label: "RESERVA", href: gate(`${modBase}/reserva`), base: `${modBase}/reserva` },
    { key: "inventa", label: "INVENTA", href: gate("/staff/inventa"), base: "/staff/inventa" }
  ];
  const subSections = sections.slice(1);

  const canSwitchView = isAdminUser;

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

  return (
    <div className="min-h-screen flex flex-col bg-amber-50">
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

      {/* Topbar — brand + every control the sidebar used to host. Wraps on
          narrow viewports so nothing is unreachable on mobile. */}
      <header className="bg-gradient-to-r from-[#EFE3CF] to-[#E6D3B5] text-slate-800 border-b border-[#DDCBAE] shadow-sm">
        <div className="w-full max-w-6xl mx-auto px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <HeaderBrand role="staff" />
          {activeBranch && (
            <TodaysBranchPill
              branchName={activeBranch.name}
              hasChoice={hasBranchChoice}
              pickerPath="/staff/branch-picker"
            />
          )}
          <div className="flex-1 min-w-0" />
          <span className="hidden sm:block text-xs text-slate-500 truncate max-w-[180px]">
            {nameWithPrefix(user.title_prefix, user.display_name)}
          </span>
          {canSwitchView && (
            <div className="flex-shrink-0 [&>button]:!w-auto [&>button]:!px-3 [&>button]:!py-1.5">
              <AdminModeToggle view={adminView ? "admin" : "staff"} defaultView={defaultView} />
            </div>
          )}
          <RefreshButton variant="light" />
          <LangToggle variant="light" />
          <LogoutButton />
        </div>
      </header>

      <div className="w-full max-w-6xl mx-auto px-4 pt-4 flex-1 flex flex-col min-w-0">
        <ModuleTabs tabs={moduleTabs} />
        <div className="md:hidden mt-3">
          <ModuleSubnav sections={subSections} mode="chips" />
        </div>
        <div className="mt-4 md:flex md:gap-5 flex-1 min-w-0">
          <div className="hidden md:block md:w-[236px] md:flex-shrink-0">
            <div className="sticky top-4">
              <ModuleSubnav sections={subSections} mode="list" />
            </div>
          </div>
          {/* overflow-x-clip — page-level guard so nothing spills past the
              viewport on mobile. Wide tables keep their own overflow-x-auto. */}
          <main className="flex-1 min-w-0 overflow-x-clip pb-8">{children}</main>
        </div>
      </div>

      <div className="hidden md:block mt-auto">
        <Footer />
      </div>
      <HookFab
        audience="staff"
        helpEnabled={!!getSystemSettings().owl_help_enabled && !!process.env.ANTHROPIC_API_KEY}
      />
    </div>
  );
}
