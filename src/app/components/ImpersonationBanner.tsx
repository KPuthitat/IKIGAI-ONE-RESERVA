"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

// Renders at the TOP of every admin + staff layout when the active
// session is an impersonated one. Orange + sticky so the operator
// (super_admin / admin) can't forget they're seeing another user's
// view. Click "หยุดดูแทน" → /api/admin/impersonate/end → page reloads
// back into the operator's own session.

export default function ImpersonationBanner({
  impersonatorName, targetName
}: {
  impersonatorName: string;
  targetName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function stop() {
    setBusy(true);
    try {
      await fetch(apiUrl("/api/admin/impersonate/end"), { method: "POST" });
    } catch { /* swallow */ }
    // Hard reload — server-side getSessionUser must re-read the
    // session, and any client caches of role/branches should reset.
    if (typeof window !== "undefined") {
      window.location.href = "/admin";
    } else {
      router.refresh();
    }
  }

  return (
    <div className="sticky top-0 z-50 bg-amber-500 text-white shadow-md">
      <div className="max-w-7xl mx-auto px-3 py-2 flex items-center gap-3 text-xs sm:text-sm">
        <div className="flex-1 min-w-0">
          <span className="font-bold">{impersonatorName}</span>
          <span className="mx-1 opacity-80">→ ดูแทน</span>
          <span className="font-bold">{targetName}</span>
          <span className="ml-2 opacity-80 hidden sm:inline">
            (การกระทำทุกอย่างจะถูกบันทึกว่าเป็นการกระทำของ {impersonatorName})
          </span>
        </div>
        <button type="button" disabled={busy} onClick={stop}
          className="px-3 py-1 rounded bg-white text-amber-700 font-bold text-xs hover:opacity-90 disabled:opacity-50 flex-shrink-0">
          {busy ? "..." : "หยุดดูแทน"}
        </button>
      </div>
    </div>
  );
}
