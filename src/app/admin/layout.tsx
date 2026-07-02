import { getSessionUser, userCanViewPayroll, canModule } from "@/lib/auth";
import { getDb, getSystemSettings } from "@/lib/db";
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
import RefreshButton from "../components/RefreshButton";
import ImpersonationBanner from "../components/ImpersonationBanner";
import MaintenanceBanner from "../components/MaintenanceBanner";
import { currentImpersonationContext } from "@/lib/impersonation";
import { nameWithPrefix } from "@/lib/name";

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

  // Branch-gate (owner 2026-06-11): a module can't be opened until a branch
  // is selected. When none is set, every module link routes through the
  // branch picker first (?next=destination). The picker auto-skips when the
  // user has exactly one eligible branch, so single-branch users feel no
  // extra step — this only forces a pick for multi-branch users.
  const needBranch = !user.activeBranchId;
  const gate = (href: string) =>
    needBranch ? `/admin/branch-picker?next=${encodeURIComponent(href)}` : href;
  const sections: SidebarSection[] = [
    {
      label: t(lang, "sidebar.section.modules"),
      items: [
        { href: "/admin", label: t(lang, "sidebar.modulePicker") },
        // Module links are filtered by RBAC (2026-06-04): each appears
        // only when the user's roles grant that module. super_admin and
        // roleless full branch-admins see them all (see canModule).
        ...(canModule(user, "persona.manage") ? [{ href: gate("/admin/persona"), label: "PERSONA" }] : []),
        ...(canModule(user, "reserva.manage") ? [{ href: gate("/admin/reserva"), label: "RESERVA" }] : []),
        // INVENTA lives under /staff (clinic staff tool; admins are
        // employees too). Always shown — it's a staff-level tool, not
        // gated by the admin-module RBAC. The INVENTA settings page is
        // reached from inside INVENTA itself (its own sidebar section +
        // the toolbar) — not duplicated at module level here.
        { href: gate("/staff/inventa"), label: "INVENTA" },
        ...(canModule(user, "ascenda.view") ? [{ href: gate("/admin/ascenda"), label: "ASCENDA" }] : []),
        ...(canModule(user, "insigna.view") ? [{ href: gate("/admin/insigna"), label: "INSIGNA" }] : []),
        ...(canModule(user, "recruita.access") ? [{ href: gate("/admin/recruita"), label: "RECRUITA" }] : []),
        // ACCOUNTA — accounting + feasibility (owner 2026-06-16). RBAC-gated:
        // only admins granted accounta.manage (and super_admin / roleless
        // full-admins) see it. FEASIBILITY lives inside it.
        ...(canModule(user, "accounta.manage") ? [{ href: gate("/admin/accounta"), label: "ACCOUNTA" }] : []),
        // System-wide entries — only super_admin can manage these,
        // so hide them from regular admins to keep the sidebar clean.
        // The pages still enforce requireSuperAdmin() server-side as
        // a belt-and-braces second check.
        ...(isSuperAdmin ? [
          { href: "/admin/roles", label: "บทบาทและสิทธิ์" },
          { href: "/admin/system-settings", label: t(lang, "admin.systemSettings.title") },
          { href: "/admin/companies", label: t(lang, "admin.companies.title") },
          // Notification quota is system-wide (every module shares the
          // LINE push allowance) → surfaced here in the global section
          // rather than buried under PERSONA (owner 2026-06-03).
          { href: "/admin/persona/messaging/quota", label: t(lang, "admin.persona.nav.messagingQuota") }
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
        { href: "/admin/persona/approval-chain", label: "สายบังคับบัญชา" },
        { href: "/admin/persona/roster", label: t(lang, "admin.persona.nav.roster") },
        { href: "/admin/persona/timesheets", label: t(lang, "admin.persona.nav.timesheets") },
        { href: "/admin/persona/timesheets/monthly", label: t(lang, "admin.persona.nav.monthlyTimesheets") },
        // PDPA: payroll entry only shown when this admin has been
        // granted access. The pages themselves still enforce
        // requirePayrollAccess server-side as a belt-and-braces check.
        ...(userCanViewPayroll(user)
          ? [{ href: "/admin/persona/payroll", label: t(lang, "admin.persona.nav.payroll") }]
          : []),
        { href: "/admin/persona/service-charge", label: t(lang, "admin.persona.nav.svc") },
        { href: "/admin/persona/ot-approvals", label: "อนุมัติการทำงานล่วงเวลา" },
        { href: "/admin/persona/shift-requests", label: "คำขอเปลี่ยนเวลางาน" },
        { href: "/admin/persona/leave", label: t(lang, "admin.persona.nav.leave") },
        { href: "/admin/persona/resignation", label: t(lang, "admin.persona.nav.resignation") },
        { href: "/admin/persona/holidays", label: t(lang, "admin.persona.nav.holidays") },
        { href: "/admin/persona/discipline", label: t(lang, "admin.persona.nav.discipline") }
      ]
    },
    // ACCOUNTA — contextual section (owner 2026-06-25). Shown when inside
    // /admin/accounta. The เอกสารรอลงบัญชี inbox + สิทธิ์ matrix live here.
    ...(canModule(user, "accounta.manage") ? [{
      label: "ACCOUNTA",
      pathPrefix: "/admin/accounta",
      items: [
        { href: "/admin/accounta", label: "ภาพรวม ACCOUNTA" },
        { href: "/admin/accounta/daybook", label: "บัญชีรายรับรายจ่าย" },
        { href: "/admin/accounta/inbox", label: "เอกสารรอลงบัญชี" },
        { href: "/admin/accounta/expenses", label: "รายจ่าย" },
        { href: "/admin/accounta/recurring", label: "รายจ่ายประจำ (อัตโนมัติ)" },
        { href: "/admin/accounta/income", label: "รายรับ" },
        { href: "/admin/accounta/receivables", label: "ลูกหนี้ค้างชำระ" },
        { href: "/admin/accounta/vendors", label: "ผู้จำหน่าย / คู่ค้า" },
        { href: "/admin/accounta/cash-accounts", label: "ช่องทางการเงิน / บัญชี" },
        { href: "/admin/accounta/credit-cards", label: "บัตรเครดิตกรรมการ" },
        ...(isSuperAdmin ? [{ href: "/admin/accounta/access", label: "สิทธิ์เข้าถึงตามสาขา" }] : [])
      ]
    }] : []),
    // สุขภาพพนักงาน — รวม "ผลตรวจสุขภาพ" (ย้ายมาจาก PERSONA) + โครงการ Mounjaro.
    // Mounjaro (คลินิก) เห็นเฉพาะแพทย์ · ภาพรวม (HR) เห็นเฉพาะผู้มีสิทธิ์ aggregate.
    {
      label: "สุขภาพพนักงาน",
      items: [
        { href: "/admin/persona/health", label: t(lang, "admin.persona.nav.health") },
        ...(user.clinical_role === "doctor"
          ? [{ href: "/admin/mounjaro", label: "โครงการควบคุมน้ำหนัก (แพทย์)" }] : []),
        ...(user.is_hr_analytics === 1
          ? [{ href: "/admin/mounjaro-hr", label: "ภาพรวมสุขภาพพนักงาน (HR)" }] : []),
        // System-level health config — super_admin only (the pages also
        // enforce requireSuperAdmin server-side). Moved here from the
        // global section so all health settings live under one menu.
        ...(isSuperAdmin ? [
          { href: "/admin/mounjaro-consent", label: "PDPA ข้อมูลสุขภาพ" },
          { href: "/admin/health/facilities", label: "สถานพยาบาลที่ปรึกษาสุขภาพ" }
        ] : [])
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
        // Notification quota moved to the global section (top of sidebar)
        // — it's shared across all modules (owner 2026-06-03).
        { href: "/admin/persona/notifications", label: "ปรับแต่งการ์ดแจ้งเตือน" },
        { href: "/admin/persona/test-notifications", label: "ทดสอบการแจ้งเตือน" },
        { href: "/admin/persona/settings", label: t(lang, "admin.persona.nav.settings") }
        // Legacy iframe link removed 2026-05-13 — all features are
        // now native PERSONA pages. /admin/persona/legacy still
        // resolves by URL for ~2 weeks during transition, can be
        // deleted afterwards.
      ]
    },
    {
      label: "RECRUITA",
      pathPrefix: "/admin/recruita",
      items: [
        { href: "/admin/recruita", label: t(lang, "admin.recruita.nav.landing") },
        { href: "/admin/recruita/positions", label: t(lang, "admin.recruita.nav.positions") },
        { href: "/admin/recruita/pipeline", label: t(lang, "admin.recruita.nav.pipeline") },
        { href: "/admin/recruita/applications", label: t(lang, "admin.recruita.nav.applications") },
        { href: "/admin/recruita/interview-slots", label: t(lang, "admin.recruita.nav.interviewSlots") },
        { href: "/admin/recruita/dashboard", label: t(lang, "admin.recruita.nav.dashboard") },
        { href: "/admin/recruita/form-template", label: t(lang, "admin.recruita.nav.formTemplate") }
        // "ตั้งค่า LINE OA" moved to /admin/system-settings (global,
        // superadmin only — RECRUITA OA is shared across all branches
        // so it belongs in the global section, not the module nav).
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
        // ผังโต๊ะ (spatial floor-plan) stays hidden — superseded by the
        // timetable + per-table management. Page kept for reversibility.
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

  // Maintenance banner — renders ONLY when both fields are set:
  //   • maintenance_active = 1 (toggle ON)
  //   • maintenance_message non-empty (template text exists)
  // Same logic mirrored in staff layout — see there for full notes.
  let maintenanceMsg: string | null = null;
  try {
    const ss = getSystemSettings();
    if (ss.maintenance_active === 1 && ss.maintenance_message?.trim()) {
      maintenanceMsg = ss.maintenance_message.trim();
    }
  } catch {
    maintenanceMsg = null;
  }

  // Mobile-only footer for the sidebar: branch pill, lang toggle,
  // logout. Desktop keeps these in the topbar (md+). On mobile the
  // topbar reduces to just the program name so the row never wraps
  // or collides with the menu button, and these controls live one
  // tap away inside the slide-in sidebar instead.
  const mobileSidebarFooter = (
    <div className="space-y-3">
      {/* STAFF / ADMIN switch — shown to anyone with admin powers:
          super_admin (so the owner can pop into staff mode for
          testing), branch-admins (employee first, admin rights
          second), and — since RBAC (2026-06-04) — any staffer granted
          an admin-module role. Plain staff get no toggle. */}
      {(user.role === "super_admin" ||
        (user.role === "admin" && user.adminBranchIds.length > 0) ||
        user.permissions.length > 0) && (
        <AdminModeToggle view="admin" defaultView={user.role === "super_admin" ? "admin" : "staff"} />
      )}
      <div className="md:hidden space-y-3">
        {/* Branch pill removed from mobile sidebar footer 2026-05-25
            — it's now in the sidebar brand area (visible to all
            viewport sizes), so the footer-duplicate is redundant. */}
        <div className="text-xs text-white/60 truncate">
          {nameWithPrefix(user.title_prefix, user.display_name)} · {t(lang, "role.adminShort")}
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
    <div className="min-h-screen flex bg-amber-50">
      {/* Maintenance banner above impersonation banner — see staff
          layout for the same ordering rationale. */}
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
            <AdminSidebarBrand />
            {/* Branch pill under brand (2026-05-25 per owner direction
                — moved from desktop topbar). Always visible in the
                sidebar so admin can swap branches at any point
                without hunting in the topbar. */}
            {activeBranch && (
              <TodaysBranchPill
                branchName={activeBranch.name}
                hasChoice={hasBranchChoice}
                pickerPath="/admin/branch-picker"
              />
            )}
          </div>
        }
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
              {/* Branch pill moved into sidebar 2026-05-25 — see
                  sidebar brand slot above. Topbar now carries only
                  brand + user info + lang / logout. */}
            </div>
            <div className="hidden md:block text-xs text-white/60 truncate max-w-[200px] flex-shrink-0">
              {nameWithPrefix(user.title_prefix, user.display_name)} · {t(lang, "role.adminShort")}
            </div>
            {/* Refresh — all breakpoints (web-app users have no browser
                reload button). */}
            <RefreshButton variant="dark" />
            <div className="hidden md:flex items-center gap-2 flex-shrink-0">
              <LangToggle variant="dark" />
              <LogoutButton />
            </div>
          </div>
        </header>
        {/* 2026-05-27: bumped max-w-6xl → max-w-screen-2xl (1152 → 1536 px)
            so data-heavy tables (employees, leave list, payroll) don't
            wrap Thai names onto 2 lines on common desktop widths.
            Long-form text pages can still narrow themselves inside with
            their own max-w wrapper if they want. */}
        {/* overflow-x-clip — page-level guard so nothing can spill past the
            viewport on mobile (owner R1). Wide tables wrapped in their own
            overflow-x-auto still scroll internally. */}
        <main className="flex-1 w-full p-4 max-w-screen-2xl mx-auto overflow-x-clip">{children}</main>
        {/* Desktop only — on mobile this info moves into the sidebar
            bottom (see mobileSidebarFooter) so the page isn't crowded. */}
        <div className="hidden md:block mt-auto">
          <Footer />
        </div>
      </div>
      <HookFab
        audience="admin"
        aiEnabled={!!getSystemSettings().owl_ai_enabled && !!process.env.ANTHROPIC_API_KEY}
        helpEnabled={!!getSystemSettings().owl_help_enabled && !!process.env.ANTHROPIC_API_KEY}
      />
    </div>
  );
}
