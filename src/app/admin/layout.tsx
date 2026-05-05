import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import BranchSwitcher from "./BranchSwitcher";
import LogoutButton from "./LogoutButton";

export const dynamic = "force-dynamic";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  // หน้าที่ต้องการ auth จะเรียก requireUser() ใน page เอง (จะ redirect ไป login)
  // ถ้ายังไม่มี session ก็ render children ตรงๆ (เช่นหน้า login)
  const user = getSessionUser();
  if (!user) return <>{children}</>;

  const navItems = [
    { href: "/admin", label: "ภาพรวม" },
    { href: "/admin/bookings", label: "การจอง" },
    { href: "/admin/floor-plan", label: "ผังโต๊ะ", adminOnly: true },
    { href: "/admin/staff", label: "พนักงาน", adminOnly: true },
    { href: "/admin/settings", label: "ตั้งค่า", adminOnly: true },
    { href: "/admin/export", label: "Export", adminOnly: true }
  ];

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4 flex-wrap">
          <Link href="/admin" className="font-bold text-brand">RESERVA</Link>
          <BranchSwitcher
            branches={user.branches}
            activeBranchId={user.activeBranchId}
          />
          <nav className="flex gap-1 ml-auto flex-wrap">
            {navItems
              .filter((n) => !n.adminOnly || user.role === "admin")
              .map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="px-3 py-1.5 rounded-md text-sm hover:bg-slate-100"
                >
                  {n.label}
                </Link>
              ))}
            <span className="ml-3 text-sm text-slate-500 self-center">
              {user.display_name} ({user.role === "admin" ? "แอดมิน" : "พนักงาน"})
            </span>
            <LogoutButton />
          </nav>
        </div>
      </header>
      <main className="max-w-6xl mx-auto p-4">{children}</main>
    </div>
  );
}
