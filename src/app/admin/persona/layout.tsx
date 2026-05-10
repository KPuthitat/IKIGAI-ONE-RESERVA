import { requireAdmin } from "@/lib/auth";
import BranchSwitcher from "../BranchSwitcher";

export const dynamic = "force-dynamic";

// PERSONA layout — module nav lives in the global Sidebar
// (see /admin/layout.tsx). Mirrors the RESERVA layout: a topbar with a
// BranchSwitcher so admin can scope per-branch content (employees,
// timesheets, payroll, checklist, etc.) just by switching the dropdown.
//
// /admin/persona/legacy uses fixed-position iframe and overlays this
// layout — the switcher is not visible underneath, which is fine since
// the legacy app has its own branch context.
export default function PersonaLayout({ children }: { children: React.ReactNode }) {
  const user = requireAdmin();
  return (
    <div>
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 mb-4 p-3 flex items-center gap-3 flex-wrap">
        <BranchSwitcher branches={user.branches} activeBranchId={user.activeBranchId} />
      </div>
      {children}
    </div>
  );
}
