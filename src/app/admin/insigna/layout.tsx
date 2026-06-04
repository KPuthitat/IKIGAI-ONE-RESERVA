import { requirePermission } from "@/lib/auth";

export const dynamic = "force-dynamic";

// INSIGNA layout — gates the module subtree with the insigna.view
// permission (RBAC, 2026-06-04). super_admin and roleless full
// branch-admins still pass (see canModule).
export default function InsignaLayout({ children }: { children: React.ReactNode }) {
  requirePermission("insigna.view");
  return <>{children}</>;
}
