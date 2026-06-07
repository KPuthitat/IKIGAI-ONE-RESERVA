"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useLang } from "@/lib/LangProvider";

// A single view-switch button shown ONLY to users granted admin rights
// (the layout decides whether to mount it). An admin is an employee
// first — they live in employee view and tap this to enter the admin
// console; super_admin can tap it the other way to preview what staff
// see.
//
// The chosen view is PERSISTED in the `os_view` cookie (owner 2026-06-08).
// Why: INVENTA lives under /staff, so an admin opening it from the admin
// console used to "fall" into staff view with no easy way back. Now the
// cookie remembers the intent — the staff layout reads it and, for an
// admin in "admin view", keeps the module links pointing at /admin so
// they never get stranded. The layout passes the effective `view`; we
// also re-sync the cookie to the portal actually being shown.
//
//   In staff view  → "มุมมองผู้ดูแลระบบ"  (go to /admin,  chevron →)
//   In admin view  → "มุมมองพนักงาน"      (go to /staff,  chevron ←)

const VIEW_COOKIE = "os_view";

function writeView(v: "admin" | "staff") {
  // 1 year, root path, lax — purely a UI preference, no sensitive data.
  document.cookie = `${VIEW_COOKIE}=${v}; path=/; max-age=31536000; samesite=lax`;
}

export default function AdminModeToggle({ view }: { view?: "admin" | "staff" }) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const { lang } = useLang();

  // Effective current view: the layout's cookie-aware prop wins; fall back
  // to the URL for safety if a caller doesn't pass it.
  const current: "admin" | "staff" =
    view ?? ((pathname === "/admin" || pathname.startsWith("/admin/")) ? "admin" : "staff");
  const inAdmin = current === "admin";

  // Keep the cookie in sync with the portal actually shown, so a fresh
  // visit / bookmark to /admin marks the intent before the user clicks
  // a cross-portal link (e.g. INVENTA → /staff/inventa).
  useEffect(() => { writeView(current); }, [current]);

  const label = inAdmin
    ? (lang === "en" ? "Staff view" : "มุมมองพนักงาน")
    : (lang === "en" ? "Admin view" : "มุมมองผู้ดูแลระบบ");

  function go() {
    const target = inAdmin ? "staff" : "admin";
    writeView(target);
    router.push(target === "admin" ? "/admin" : "/staff");
  }

  return (
    <button
      type="button"
      onClick={go}
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
