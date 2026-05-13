"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

// Adaptive topbar brand. Two visual states driven by sidebar visibility:
//
//   • Sidebar OPEN  → compact single-line "IKIGAI OS • MODULE / ROLE"
//     because the brand competes for horizontal space with the
//     language toggle + logout button on the same row.
//
//   • Sidebar CLOSED → two-line masthead with a large IKIGAI OS
//     wordmark and the MODULE / ROLE on a second line, both
//     left-aligned. With the sidebar collapsed the header gains
//     ~16 rem of horizontal real estate so the brand can fill it.
//
// State sync uses a CustomEvent dispatched by Sidebar (see
// Sidebar.tsx's persist effect) plus an initial localStorage read.
// We avoid a Context to keep the surrounding layout a pure server
// component.

const MODULE_BY_PREFIX: Array<[string, string]> = [
  ["/admin/reserva", "RESERVA"],
  ["/admin/persona", "PERSONA"],
  ["/admin/ascenda", "ASCENDA"],
  ["/staff/reserva", "RESERVA"],
  ["/staff/persona", "PERSONA"],
  ["/staff/ascenda", "ASCENDA"]
];

const SIDEBAR_STORAGE_KEY = "sidebar-open";

export default function HeaderBrand({ role }: { role: "admin" | "staff" }) {
  const pathname = usePathname() || "";
  const moduleEntry = MODULE_BY_PREFIX.find(([prefix]) =>
    pathname.startsWith(prefix)
  );
  const moduleName = moduleEntry?.[1];

  // Initial render always assumes sidebar OPEN (the storage default)
  // so SSR HTML and the first client render agree — useEffect then
  // reconciles with the real localStorage value, and the event
  // listener keeps it live thereafter.
  const [sidebarOpen, setSidebarOpen] = useState(true);
  useEffect(() => {
    try {
      const v = localStorage.getItem(SIDEBAR_STORAGE_KEY);
      if (v === "0") setSidebarOpen(false);
    } catch { /* ignore */ }
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ open: boolean }>;
      if (typeof ce.detail?.open === "boolean") setSidebarOpen(ce.detail.open);
    };
    window.addEventListener("sidebar-state-change", handler);
    return () => window.removeEventListener("sidebar-state-change", handler);
  }, []);

  // ── Compact (sidebar open) ─────────────────────────────────────
  if (sidebarOpen) {
    return (
      <div className="flex items-baseline gap-1 whitespace-nowrap text-sm sm:text-base">
        <Link href={`/${role}`} className="brand-wordmark text-white">
          IKIGAI OS
        </Link>
        {moduleName && (
          <>
            <span className="text-white/40 px-0.5">•</span>
            <span className="text-white/85 font-light tracking-[0.5px]">
              {moduleName}
            </span>
          </>
        )}
        <span className="text-white/40 ml-2 hidden sm:inline">/</span>
        <span className="text-white/60 font-light tracking-[1.5px] uppercase hidden sm:inline">
          {role}
        </span>
      </div>
    );
  }

  // ── Masthead (sidebar closed) ──────────────────────────────────
  // Mirrors the sidebar brand's typographic system so that when the
  // sidebar collapses the topbar visually picks up where the sidebar
  // brand left off — same wordmark face, same uppercase-tracked
  // subtitle, just sized one step up to reflect the topbar's wider
  // canvas. Keeps the page from feeling like two different brand
  // identities depending on sidebar state.
  const subtitle = moduleName ? `${moduleName} · ${role}` : role;
  return (
    <Link href={`/${role}`} className="block leading-tight">
      <div className="brand-wordmark text-white text-xl sm:text-2xl md:text-3xl">
        IKIGAI OS
      </div>
      <div className="text-[10px] tracking-[2px] text-white/50 uppercase mt-1">
        {subtitle}
      </div>
    </Link>
  );
}
