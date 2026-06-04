import { requirePermission } from "@/lib/auth";

export const dynamic = "force-dynamic";

// RECRUITA layout — gates the whole module subtree with the
// recruita.access permission (RBAC, 2026-06-04). super_admin and
// roleless full branch-admins still pass (see canModule). The
// individual pages keep their requireAdmin() check as a second line
// of defence; this layout is the module-level gate.
export default function RecruitaLayout({ children }: { children: React.ReactNode }) {
  requirePermission("recruita.access");
  return <>{children}</>;
}
