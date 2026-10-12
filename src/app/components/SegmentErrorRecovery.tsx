"use client";

// Recovery boundary for a gated area (admin / staff). When a page in the
// segment throws — a stale JS chunk after a deploy (common in the LINE in-app
// browser), an expired session that slipped past a guard, or a transient DB
// hiccup — the user should be able to RE-ENTER (log in / enter their code),
// not stare at a dead "system error" card (owner 2026-09-24: a tapped shortcut
// into an admin menu must land on the login/PIN screen, not an error).
//
// Rendered inside the root layout, so globals.css + the brand font are in
// scope (unlike global-error.tsx, which replaces the root layout).

import { useEffect } from "react";

const BRAND = "#6B4FD8";
const INK = "#18103a";

export default function SegmentErrorRecovery({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[segment-error]", error.message, error.digest);
  }, [error]);

  function goLogin() {
    // Carry the page they were on through login so they return to it (and, if
    // admin mode is locked, land on the PIN screen) after re-authenticating.
    let target = "/login";
    try {
      const p = window.location.pathname + window.location.search;
      if (p.startsWith("/")) target = `/login?next=${encodeURIComponent(p)}`;
    } catch {
      /* window unavailable — plain /login */
    }
    window.location.href = target;
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-5"
      style={{ background: "linear-gradient(135deg, #f6f5fc 0%, #e6e1f7 100%)" }}>
      <div className="w-full max-w-md rounded-3xl border p-8 text-center"
        style={{ background: "#fcfbff", borderColor: "#ddd7f7", boxShadow: "0 8px 30px rgba(40,26,100,0.12)" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/mascot/wai.webp" alt="" width={104} height={104} className="mx-auto mb-3" style={{ objectFit: "contain" }} />
        <h1 className="text-xl font-bold" style={{ color: INK }}>เปิดหน้านี้ไม่สำเร็จ</h1>
        <p className="text-sm mt-2 leading-relaxed" style={{ color: "#6b5c49" }}>
          ถ้าเพิ่งกดเข้ามาจากลิงก์ เซสชันอาจหมดอายุค่ะ
          <br />
          ลองเข้าสู่ระบบอีกครั้ง หรือกดลองใหม่
        </p>
        <div className="flex gap-2 justify-center mt-6">
          <button type="button" onClick={reset}
            className="flex-1 rounded-xl px-4 py-2.5 text-sm font-bold"
            style={{ border: `1px solid ${BRAND}`, background: "transparent", color: BRAND }}>
            ลองอีกครั้ง
          </button>
          <button type="button" onClick={goLogin}
            className="flex-1 rounded-xl px-4 py-2.5 text-sm font-bold text-white"
            style={{ background: BRAND }}>
            เข้าสู่ระบบ
          </button>
        </div>
        {error.digest && (
          <p className="mt-5 font-mono" style={{ fontSize: 10, color: "#b3a892" }}>ref: {error.digest}</p>
        )}
      </div>
    </div>
  );
}
