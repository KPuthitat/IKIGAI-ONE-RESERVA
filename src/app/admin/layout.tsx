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
    <div className="min-h-screen bg-slate-100">
      <header className="bg-ink-gradient text-white shadow-lg">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4 flex-wrap">
          <Link href="/admin" className="brand-wordmark text-white text-lg">
            IKIGAI ONE <span className="text-white/60 font-normal text-sm tracking-normal">· RESERVA</span>
          </Link>
          <div className="hidden sm:block h-6 w-px bg-white/20" />
          <BranchSwitcher
            branches={user.branches}
            activeBranchId={user.activeBranchId}
          />
          <nav className="flex gap-1 ml-auto flex-wrap items-center">
            {navItems
              .filter((n) => !n.adminOnly || user.role === "admin")
              .map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="px-3 py-1.5 rounded-md text-sm text-white/80 hover:text-white hover:bg-white/10 transition-colors"
                >
                  {n.label}
                </Link>
              ))}
            <span className="ml-3 text-xs text-white/60 self-center">
              {user.display_name} · {user.role === "admin" ? "แอดมิน" : "พนักงาน"}
            </span>
            <LogoutButton />
          </nav>
        </div>
      </header>
      <main className="max-w-6xl mx-auto p-4">{children}</main>
    </div>
  );
}
