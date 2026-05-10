"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

// Collapsible left sidebar — used by /admin and /staff layouts.
//
// Behaviour:
//  - Desktop (md+): static panel, default open. Toggle slides it off-screen
//    and main content reclaims the width. State persists in localStorage.
//  - Mobile: fixed overlay with backdrop. Default closed; toggle slides it in.
//
// Items are passed in as a prop so each layout supplies its own navigation.

export type SidebarItem = {
  href: string;
  label: string;
  /** Renders the row with the "danger/legacy" amber styling. */
  legacy?: boolean;
  /**
   * Optional count badge rendered on the right of the row (e.g. "3" for
   * pending bookings awaiting review). Omitted or 0 → no badge.
   * Use `"!"` for a non-numeric attention dot.
   */
  badge?: number | string;
};

export type SidebarSection = {
  /** Section heading text. Empty string = no heading (single flat list). */
  label: string;
  items: SidebarItem[];
  /** Optional content rendered above the items (e.g., BranchSwitcher). */
  topSlot?: React.ReactNode;
  /**
   * If set, only render this section when the current pathname starts with
   * this prefix (or equals it). Use this to scope nav items to a specific
   * module — e.g. PERSONA items only show when in /admin/persona/*.
   * Omit to always render the section.
   */
  pathPrefix?: string;
};

const STORAGE_KEY = "sidebar-open";

export default function Sidebar({
  sections,
  brand,
  defaultOpen = true
}: {
  sections: SidebarSection[];
  /** Optional custom brand element rendered at the very top of the sidebar. */
  brand?: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState<boolean>(defaultOpen);
  const [hydrated, setHydrated] = useState(false);

  // Restore from localStorage on mount
  useEffect(() => {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v === "0") setOpen(false);
      else if (v === "1") setOpen(true);
    } catch { /* ignore */ }
    setHydrated(true);
  }, []);

  // Persist
  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(STORAGE_KEY, open ? "1" : "0"); } catch { /* ignore */ }
  }, [open, hydrated]);

  // Close sidebar when navigating on mobile
  useEffect(() => {
    if (window.matchMedia("(max-width: 767px)").matches) {
      setOpen(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  function isActive(href: string): boolean {
    // Split href into pathname + query so two items sharing a route
    // but differing by ?type= (admin checklist editor for shift_open
    // vs shift_close vs readiness_*) can be distinguished.
    const [itemPath, itemQuery] = href.split("?");
    // Top-level "/admin" / "/staff" only match exactly — otherwise
    // they'd be considered active on every nested page.
    if (href === "/admin" || href === "/staff") return pathname === href;
    if (itemPath !== pathname) {
      // Different path: parent-of-current still counts (e.g. nav
      // entry for /admin/persona stays lit on /admin/persona/employees).
      return pathname.startsWith(itemPath + "/");
    }
    // Same path. Item with an explicit query is only active when the
    // current URL has the same query. Query-less item is always active
    // when paths match — the typical case.
    if (itemQuery) {
      const itemParams = new URLSearchParams(itemQuery);
      for (const [k, v] of itemParams) {
        if (searchParams.get(k) !== v) return false;
      }
      return true;
    }
    return true;
  }

  // Filter sections by current pathname (sections without pathPrefix always show)
  const visibleSections = sections.filter((s) =>
    !s.pathPrefix || pathname === s.pathPrefix || pathname.startsWith(s.pathPrefix + "/")
  );

  return (
    <>
      {/* Toggle button. Closed → hamburger at top-left of viewport so
          it's reachable. Open → close (✕) snaps inside the sidebar's
          top-right corner so it doesn't overlap the brand text or the
          page content beneath. */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`fixed top-3 z-50 w-9 h-9 rounded-lg shadow-md flex items-center justify-center transition-[left] duration-200 ease-out ${
          open
            ? "left-52 bg-white/10 border border-white/20 text-white hover:bg-white/20"
            : "left-3 bg-white/95 border border-slate-200 text-slate-700 hover:bg-slate-50"
        }`}
        aria-label="Toggle sidebar"
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2">
          {open ? (
            <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
          ) : (
            <path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16" />
          )}
        </svg>
      </button>

      {/* Backdrop (mobile only) */}
      {open && (
        <div
          className="md:hidden fixed inset-0 z-30 bg-black/40"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed md:sticky top-0 left-0 z-40
          h-screen
          flex-shrink-0
          bg-ink-gradient text-white shadow-xl
          overflow-y-auto
          transition-all duration-200 ease-out
          ${open ? "w-64 translate-x-0" : "w-64 -translate-x-full md:w-0"}
        `}
      >
        <div className="px-4 pt-4 pb-3 border-b border-white/10">
          {brand}
        </div>

        <nav className="p-3 space-y-5">
          {visibleSections.map((s, i) => (
            <div key={i}>
              {s.label && (
                <div className="text-[10px] font-bold tracking-[1.5px] text-white/40 uppercase px-2 mb-1.5">
                  {s.label}
                </div>
              )}
              {s.topSlot && (
                <div className="px-2 mb-2">{s.topSlot}</div>
              )}
              <ul className="space-y-0.5">
                {s.items.map((item) => {
                  const active = isActive(item.href);
                  const baseCls = active
                    ? "bg-white/15 text-white font-medium"
                    : item.legacy
                    ? "text-amber-200/80 hover:bg-amber-400/10 hover:text-amber-200"
                    : "text-white/75 hover:bg-white/10 hover:text-white";
                  const showBadge = item.badge !== undefined &&
                    item.badge !== 0 && item.badge !== "0" && item.badge !== "";
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${baseCls}`}
                      >
                        <span className="flex-1 truncate">{item.label}</span>
                        {showBadge && (
                          <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-brand text-white text-[11px] font-bold leading-none">
                            {item.badge}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
}
