"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

// Records which module the user opened, on every /staff navigation, so the
// landing page can order their cards by usage (owner 2026-09-20). Fire-and-forget:
// a failed beacon is swallowed and never affects the page. Segments that aren't
// real modules (the picker, the branch picker) are skipped.

const SKIP = new Set(["", "branch-picker"]);

export default function ModuleVisitTracker() {
  const pathname = usePathname();
  const last = useRef<string | null>(null);

  useEffect(() => {
    if (!pathname) return;
    const parts = pathname.split("/").filter(Boolean); // e.g. ["staff","persona",...]
    if (parts[0] !== "staff") return;
    const seg = parts[1] ?? "";
    if (SKIP.has(seg)) return;      // /staff itself (the landing) → nothing to record
    if (last.current === seg) return;
    last.current = seg;
    try {
      fetch("/api/track/module", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ module: seg }),
        keepalive: true
      }).catch(() => {});
    } catch { /* ignore */ }
  }, [pathname]);

  return null;
}
