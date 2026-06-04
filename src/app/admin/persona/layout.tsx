import { requirePermission } from "@/lib/auth";

export const dynamic = "force-dynamic";

// PERSONA layout — module nav lives in the global Sidebar (see
// /admin/layout.tsx). The branch switcher used to live here as a
// dropdown above content; it's now a topbar pill in the parent
// admin layout (see TodaysBranchPill), so this layout is a passthrough.
//
// RBAC (2026-06-04): the whole PERSONA subtree is gated by the
// persona.manage permission. Payroll subpages add their own
// requirePayrollAccess on top (PDPA — separate grant). super_admin and
// roleless full branch-admins still pass (see canModule).
//
// /admin/persona/legacy uses fixed-position iframe and overlays this
// layout — unaffected by the change.
export default function PersonaLayout({ children }: { children: React.ReactNode }) {
  requirePermission("persona.manage");
  return <>{children}</>;
}
