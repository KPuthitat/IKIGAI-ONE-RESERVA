"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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
};

export type SidebarSection = {
  /** Section heading text. Empty string = no heading (single flat list). */
  label: string;
  items: SidebarItem[];
  /** Optional content rendered above the items (e.g., BranchSwitcher). */
  topSlot?: React.ReactNode;
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
    if (href === pathname) return true;
    // /admin/persona is parent of /admin/persona/employees etc.
    // but /admin should NOT match /admin/persona — only exact for top-level
    if (href === "/admin" || href === "/staff") return pathname === href;
    return pathname.startsWith(href + "/") || pathname === href;
  }

  return (
    <>
      {/* Toggle button — fixed top-left, always visible */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="fixed top-3 left-3 z-50 w-9 h-9 rounded-lg bg-white/95 border border-slate-200 shadow-md text-slate-700 hover:bg-slate-50 flex items-center justify-center"
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
          {sections.map((s, i) => (
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
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={`block px-3 py-2 rounded-md text-sm transition-colors ${baseCls}`}
                      >
                        {item.label}
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
