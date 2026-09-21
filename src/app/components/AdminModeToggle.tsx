"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useLang } from "@/lib/LangProvider";
import { apiUrl } from "@/lib/url";
import PinPromptModal from "./PinPromptModal";

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

export default function AdminModeToggle({
  view, className = ""
}: {
  view?: "admin" | "staff";
  /** Extra classes from the layout (e.g. flex-1 for balanced widths). */
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const { lang } = useLang();
  const [pinOpen, setPinOpen] = useState(false);

  // Effective current view: the layout's cookie-aware prop wins; fall back
  // to the URL for safety if a caller doesn't pass it.
  const current: "admin" | "staff" =
    view ?? ((pathname === "/admin" || pathname.startsWith("/admin/")) ? "admin" : "staff");
  const inAdmin = current === "admin";
  const target: "admin" | "staff" = inAdmin ? "staff" : "admin";

  // Keep the cookie in sync with the portal actually shown, so a fresh
  // visit / bookmark to /admin marks the intent before the user clicks
  // a cross-portal link (e.g. INVENTA → /staff/inventa).
  useEffect(() => { writeView(current); }, [current]);

  const label = inAdmin
    ? (lang === "en" ? "Staff view" : "มุมมองพนักงาน")
    : (lang === "en" ? "Admin view" : "มุมมองผู้ดูแลระบบ");

  async function navigate(to: "admin" | "staff") {
    writeView(to);
    if (to === "staff") {
      // Leaving admin clears the PIN unlock so returning re-prompts the PIN
      // (owner 2026-09-21). Best-effort — the httpOnly cookie can only be
      // cleared server-side.
      try { await fetch(apiUrl("/api/auth/lock-admin"), { method: "POST" }); } catch { /* ignore */ }
    }
    // Owner 2026-06-10: every mode switch goes through the branch picker
    // first, so you always confirm which branch you're working in before
    // touching a module. The pickers auto-skip when there's only one
    // eligible branch, so single-branch users feel no extra step.
    router.push(to === "admin"
      ? "/admin/branch-picker?next=/admin"
      : "/staff/branch-picker?next=/staff");
  }

  function go() {
    // Entering admin always requires the PIN; leaving admin is free
    // (owner 2026-09-21).
    if (target === "admin") { setPinOpen(true); return; }
    void navigate("staff");
  }

  // PinPromptModal submit — verify the PIN and unlock admin server-side, then switch.
  async function verifyAndSwitch(pin: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const res = await fetch(apiUrl("/api/auth/unlock-admin"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) return { ok: false, message: j.error ?? "wrong_pin" };
    setPinOpen(false);
    navigate(target);
    return { ok: true };
  }

  return (
    <>
      <button
        type="button"
        onClick={go}
        className={`group flex items-center justify-center gap-2 h-10 px-3
                   rounded-xl border border-white/20 bg-white/10
                   hover:bg-white/20
                   text-white/90 hover:text-white text-[13px] font-semibold
                   tracking-wide transition-colors min-w-0 ${className}`}
      >
        {inAdmin && (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"
            className="opacity-60 group-hover:opacity-100 transition-transform
                       group-hover:-translate-x-0.5">
            <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        <span className="truncate">{label}</span>
        {!inAdmin && (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"
            className="opacity-60 group-hover:opacity-100 transition-transform
                       group-hover:translate-x-0.5">
            <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      {pinOpen && (
        <PinPromptModal
          title={target === "admin" ? "เข้าสู่มุมมองผู้ดูแลระบบ" : "เข้าสู่มุมมองพนักงาน"}
          description={
            <>ใส่ PIN ของคุณเพื่อสลับไปยัง
              <b>{target === "admin" ? " มุมมองผู้ดูแลระบบ" : " มุมมองพนักงาน"}</b>
            </>
          }
          submitLabel="ยืนยัน"
          onSubmit={verifyAndSwitch}
          onClose={() => setPinOpen(false)}
        />
      )}
    </>
  );
}
