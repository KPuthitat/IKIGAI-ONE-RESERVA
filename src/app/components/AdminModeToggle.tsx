"use client";

import { usePathname, useRouter } from "next/navigation";
import { useLang } from "@/lib/LangProvider";

// A single view-switch button shown ONLY to users granted admin rights
// (the layout decides whether to mount it). An admin is an employee
// first — they live in employee view and tap this to enter the admin
// console; super_admin can tap it the other way to preview what staff
// see. The label reflects where you'd GO, derived from the current path.
//
//   In staff view  → "มุมมองผู้ดูแลระบบ"  (go to /admin,  chevron →)
//   In admin view  → "มุมมองพนักงาน"      (go to /staff,  chevron ←)
//
// Restyled 2026-06-03: was a chunky STAFF | ADMIN segmented control with
// a busy swap-arrows glyph — now a clean pill with one thin direction
// chevron, no emoji, sitting quietly on the warm sidebar.
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
      className="group w-full flex items-center justify-center gap-2 px-3.5 py-2.5
                 rounded-xl border border-white/15 bg-white/[0.06]
                 hover:bg-white/[0.12] hover:border-white/30
                 text-white/90 hover:text-white text-sm font-semibold
                 tracking-wide transition-colors"
    >
      {inAdmin && (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"
          className="opacity-60 group-hover:opacity-100 transition-transform
                     group-hover:-translate-x-0.5">
          <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      <span>{label}</span>
      {!inAdmin && (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"
          className="opacity-60 group-hover:opacity-100 transition-transform
                     group-hover:translate-x-0.5">
          <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}
