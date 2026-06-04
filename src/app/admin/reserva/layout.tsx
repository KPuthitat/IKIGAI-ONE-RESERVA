import { requirePermission } from "@/lib/auth";

export const dynamic = "force-dynamic";

// RESERVA layout — module nav lives in the global Sidebar (see
// /admin/layout.tsx). The branch switcher used to live here as a
// dropdown above content; it's now a topbar pill in the parent
// admin layout (see TodaysBranchPill), so this layout is a passthrough.
//
// RBAC (2026-06-04): the whole RESERVA subtree is gated by the
// reserva.manage permission. super_admin and roleless full branch-admins
// still pass (see canModule).
export default function ReservaAdminLayout({ children }: { children: React.ReactNode }) {
  requirePermission("reserva.manage");
  return <>{children}</>;
}
