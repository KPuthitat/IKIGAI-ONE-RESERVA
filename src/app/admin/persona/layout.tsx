import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

// PERSONA module sub-nav (เหมือน /admin/reserva/layout)
// /admin/persona/legacy ใช้ fixed-position iframe ทับ layout นี้ไม่ต้องกังวล
export default function PersonaLayout({ children }: { children: React.ReactNode }) {
  requireAdmin();
  const lang = getLang();

  const navItems = [
    { href: "/admin/persona", label: t(lang, "admin.persona.nav.dashboard") },
    { href: "/admin/persona/employees", label: t(lang, "admin.persona.nav.employees") },
    { href: "/admin/persona/timesheets", label: t(lang, "admin.persona.nav.timesheets") },
    { href: "/admin/persona/payroll", label: t(lang, "admin.persona.nav.payroll") },
    { href: "/admin/persona/service-charge", label: t(lang, "admin.persona.nav.svc") },
    { href: "/admin/persona/leave", label: t(lang, "admin.persona.nav.leave") },
    { href: "/admin/persona/resignation", label: t(lang, "admin.persona.nav.resignation") },
    { href: "/admin/persona/holidays", label: t(lang, "admin.persona.nav.holidays") },
    { href: "/admin/persona/reports", label: t(lang, "admin.persona.nav.reports") },
    { href: "/admin/persona/settings", label: t(lang, "admin.persona.nav.settings") }
  ];

  return (
    <div>
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 mb-4 p-3 flex items-center gap-1 flex-wrap">
        <nav className="flex gap-1 flex-wrap">
          {navItems.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="px-3 py-1.5 rounded-md text-sm text-slate-600 hover:bg-slate-100"
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <Link
          href="/admin/persona/legacy"
          className="ml-auto px-3 py-1.5 rounded-md text-sm text-amber-700 hover:bg-amber-50 border border-amber-200"
        >
          {t(lang, "admin.persona.nav.legacy")}
        </Link>
      </div>
      {children}
    </div>
  );
}
