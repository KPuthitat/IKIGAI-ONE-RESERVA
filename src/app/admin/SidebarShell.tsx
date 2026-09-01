"use client";

import { useEffect, useState, type ReactNode } from "react";

// Collapsible desktop left rail (owner 2026-09-01: "ยังอยากซ่อนไซด์บาร์ มีปุ่มเพิ่ม
// หน่อย"). A toggle button hides/shows the contextual sub-nav so data-heavy pages
// get the full width; the choice is remembered per browser (localStorage). Only
// the DESKTOP rail is affected — on mobile the sub-nav is horizontal chips above,
// so the toggle is hidden there.
export default function SidebarShell({
  sidebar, children, hideLabel, showLabel
}: {
  sidebar: ReactNode;
  children: ReactNode;
  hideLabel: string;
  showLabel: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try { setCollapsed(localStorage.getItem("admin.sidebar.collapsed") === "1"); } catch { /* ignore */ }
  }, []);

  function toggle() {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem("admin.sidebar.collapsed", next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }

  return (
    <div className="mt-5 md:mt-4 md:flex md:gap-5 flex-1 min-w-0">
      {!collapsed && (
        <div className="hidden md:block md:w-[236px] md:flex-shrink-0">
          <div className="sticky top-4">{sidebar}</div>
        </div>
      )}
      <main className="flex-1 min-w-0 overflow-x-clip pb-8">
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? showLabel : hideLabel}
          title={collapsed ? showLabel : hideLabel}
          className="hidden md:inline-flex items-center gap-1.5 mb-3 px-2.5 py-1.5 rounded-lg border border-[#EFE4D3] bg-white text-xs text-slate-500 hover:text-brand hover:border-brand/40 transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden
            className={collapsed ? "" : "rotate-180"}>
            <path d="M9 18l6-6-6-6" />
          </svg>
          {collapsed ? showLabel : hideLabel}
        </button>
        {children}
      </main>
    </div>
  );
}
