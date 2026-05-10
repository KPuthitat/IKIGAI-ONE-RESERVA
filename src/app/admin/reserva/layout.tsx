import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

// RESERVA layout — module nav lives in the global Sidebar (see
// /admin/layout.tsx). The branch switcher used to live here as a
// dropdown above content; it's now a topbar pill in the parent
// admin layout (see TodaysBranchPill), so this layout is a passthrough.
export default function ReservaAdminLayout({ children }: { children: React.ReactNode }) {
  requireAdmin();
  return <>{children}</>;
}
