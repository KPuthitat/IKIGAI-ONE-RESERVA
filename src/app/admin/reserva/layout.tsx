import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import BranchSwitcher from "./BranchSwitcher";

export const dynamic = "force-dynamic";

export default function ReservaAdminLayout({ children }: { children: React.ReactNode }) {
  const user = requireAdmin();

  const navItems = [
    { href: "/admin/reserva", label: "ภาพรวม" },
    { href: "/admin/reserva/bookings", label: "การจอง" },
    { href: "/admin/reserva/floor-plan", label: "ผังโต๊ะ", adminOnly: true },
    { href: "/admin/reserva/staff", label: "พนักงาน", adminOnly: true },
    { href: "/admin/reserva/settings", label: "ตั้งค่า", adminOnly: true },
    { href: "/admin/reserva/export", label: "Export", adminOnly: true }
  ];

  return (
    <div>
      {/* Sub-nav สำหรับ RESERVA module — branch switcher + page nav */}
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
