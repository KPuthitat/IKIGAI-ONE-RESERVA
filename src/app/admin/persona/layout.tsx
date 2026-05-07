import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

// PERSONA layout — nav lives in the global Sidebar (see /admin/layout.tsx).
// /admin/persona/legacy uses fixed-position iframe and overlays this layout.
export default function PersonaLayout({ children }: { children: React.ReactNode }) {
  requireAdmin();
  return <>{children}</>;
}
