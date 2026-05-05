import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import BranchSwitcher from "./BranchSwitcher";

export const dynamic = "force-dynamic";

export default function ReservaAdminLayout({ children }: { children: React.ReactNode }) {
  const user = requireAdmin();
  const lang = getLang();

  const navItems = [
    { href: "/admin/reserva", label: t(lang, "admin.nav.overview") },
    { href: "/admin/reserva/bookings", label: t(lang, "admin.nav.bookings") },
    { href: "/admin/reserva/floor-plan", label: t(lang, "admin.nav.floorPlan"), adminOnly: true },
    { href: "/admin/reserva/staff", label: t(lang, "admin.nav.users"), adminOnly: true },
    { href: "/admin/reserva/settings", label: t(lang, "admin.nav.settings"), adminOnly: true },
    { href: "/admin/reserva/export", label: t(lang, "admin.nav.export"), adminOnly: true }
  ];

  return (
    <div>
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 mb-4 p-3 flex items-center gap-3 flex-wrap">
        <BranchSwitcher branches={user.branches} activeBranchId={user.activeBranchId} />
        <nav className="flex gap-1 ml-auto flex-wrap">
          {navItems
            .filter((n) => !n.adminOnly || user.role === "admin")
            .map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="px-3 py-1.5 rounded-md text-sm text-slate-600 hover:bg-slate-100"
              >
                {n.label}
              </Link>
            ))}
        </nav>
      </div>
      {children}
    </div>
  );
}
