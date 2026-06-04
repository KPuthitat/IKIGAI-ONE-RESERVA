import { requirePermission } from "@/lib/auth";

export const dynamic = "force-dynamic";

// ASCENDA layout — gates the module subtree with the ascenda.view
// permission (RBAC, 2026-06-04). super_admin and roleless full
// branch-admins still pass (see canModule).
export default function AscendaLayout({ children }: { children: React.ReactNode }) {
  requirePermission("ascenda.view");
  return <>{children}</>;
}
