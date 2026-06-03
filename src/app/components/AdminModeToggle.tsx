"use client";

import { usePathname, useRouter } from "next/navigation";
import { useLang } from "@/lib/LangProvider";

// A single view-switch button shown ONLY to users granted admin rights
// (the layout decides whether to mount it). An admin is an employee
// first — they live in employee view and tap this to enter the admin
// console; super_admin can tap it the other way to preview what staff
// see. The label reflects where you'd GO, derived from the current path
// (owner 2026-06-03 — replaced the STAFF | ADMIN segmented toggle, which
// read as "pick your role" rather than "switch view").
//
//   In staff view  → "มุมมองผู้ดูแลระบบ"  (go to /admin)
//   In admin view  → "มุมมองพนักงาน"      (go to /staff)
export default function AdminModeToggle() {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const { lang } = useLang();

  const inAdmin = pathname === "/admin" || pathname.startsWith("/admin/");

  const label = inAdmin
    ? (lang === "en" ? "Staff view" : "มุมมองพนักงาน")
    : (lang === "en" ? "Admin view" : "มุมมองผู้ดูแลระบบ");

  return (
    <button
      type="button"
      onClick={() => router.push(inAdmin ? "/staff" : "/admin")}
      className="w-full flex items-center justify-center gap-2 py-2 rounded-lg
                 bg-white/10 hover:bg-white/20 text-white text-sm font-bold
                 transition-colors"
    >
      {/* swap-arrows glyph — signals "switch view", not a destination link */}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"
        className="opacity-80">
        <path d="M7 4 3 8l4 4" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round" />
        <path d="M3 8h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M17 20l4-4-4-4" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round" />
        <path d="M21 16H7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      {label}
    </button>
  );
}
