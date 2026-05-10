import { requireAdmin } from "@/lib/auth";
import BranchSwitcher from "../BranchSwitcher";

export const dynamic = "force-dynamic";

// RESERVA layout — module nav lives in the global Sidebar (see /admin/layout.tsx).
// We still render the BranchSwitcher above content so admin can switch
// the active branch from any RESERVA page.
export default function ReservaAdminLayout({ children }: { children: React.ReactNode }) {
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
