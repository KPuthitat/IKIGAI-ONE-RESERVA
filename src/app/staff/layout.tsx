import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import LogoutButton from "../admin/LogoutButton";
import HeaderBrand from "../HeaderBrand";
import LangToggle from "../LangToggle";
import Footer from "../Footer";
import Sidebar, { type SidebarSection } from "../components/Sidebar";
import StaffSidebarBrand from "./StaffSidebarBrand";
import TodaysBranchPill from "../TodaysBranchPill";

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
        { href: "/staff/reserva", label: "RESERVA" }
      ]
    },
    {
      label: "PERSONA",
      pathPrefix: "/staff/persona",
      items: [
        { href: "/staff/persona", label: t(lang, "staff.nav.timeClock") },
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
        }
      ]
    },
    {
      label: "RESERVA",
      pathPrefix: "/staff/reserva",
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
              <TodaysBranchPill
                branchName={activeBranch?.name ?? null}
                hasChoice={hasBranchChoice}
                pickerPath="/staff/branch-picker"
              />
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
