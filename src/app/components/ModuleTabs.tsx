"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Top module-tab bar (redesign 2026-08). Replaces the module-switcher
// section that used to live at the top of the dark left sidebar. Renders
// the modules a user can reach as a horizontal, scrollable row of pill
// tabs — PEAK-style — with the active module highlighted by pathname.
//
// Each tab carries a `base` (the clean module path, used for active
// detection + icon lookup) separate from `href` (where the tab actually
// navigates — which may be a branch-picker gate URL when no branch is
// selected yet). `exact` tabs (module picker, help) only light up on an
// exact pathname match so they don't stay active on every nested page.

export type ModuleTab = {
  key: string;
  label: string;
  href: string;
  base: string;
  exact?: boolean;
  badge?: number;
};

// Line icons, keyed by tab.key. Kept intentionally simple (single-stroke,
// currentColor) so they inherit the active/inactive text colour.
function Icon({ k }: { k: string }) {
  const p: Record<string, React.ReactNode> = {
    home: <path d="M3 11l9-8 9 8M5 10v10h14V10" />,
    persona: <><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20c0-3.3 2.5-5.5 5.5-5.5s5.5 2.2 5.5 5.5M16 5.2a3.2 3.2 0 010 5.6M18 20c0-2.6-1.2-4.6-3-5.3" /></>,
    reserva: <><rect x="3" y="4.5" width="18" height="16" rx="2" /><path d="M3 9h18M8 3v4M16 3v4" /></>,
    accounta: <><path d="M3 5.5h18v13H3zM3 10h18" /><path d="M7 14.5h4" /></>,
    inventa: <path d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8" />,
    ascenda: <path d="M4 19V9M10 19V4M16 19v-7M22 19H2" />,
    insigna: <><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 010 18M3 12h18" /></>,
    recruita: <><circle cx="10" cy="8" r="3.4" /><path d="M4 20c0-3.3 2.7-5.6 6-5.6M17 11v6M14 14h6" /></>,
    delivera: <><rect x="1.5" y="7" width="14" height="10" rx="1.5" /><path d="M15.5 10h4l3 3v4h-7zM6.5 20a2 2 0 100-4 2 2 0 000 4zM18.5 20a2 2 0 100-4 2 2 0 000 4z" /></>,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.2 9a3 3 0 015.6 1c0 2-2.8 2.5-2.8 4" /><circle cx="12" cy="17" r=".6" fill="currentColor" stroke="none" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 00.3 1.8 2 2 0 11-2.8 2.8 1.6 1.6 0 00-2.7 1.1 2 2 0 01-4 0 1.6 1.6 0 00-2.6-1.1 2 2 0 11-2.8-2.8A1.6 1.6 0 004 12a2 2 0 010-4 1.6 1.6 0 001.1-2.7 2 2 0 112.8-2.8A1.6 1.6 0 0010 3a2 2 0 014 0 1.6 1.6 0 002.7 1.1 2 2 0 112.8 2.8A1.6 1.6 0 0021 10a2 2 0 010 4 1.6 1.6 0 00-1.6 1z" /></>
  };
  return (
    <svg viewBox="0 0 24 24" className="w-[17px] h-[17px] flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {p[k] ?? p.settings}
    </svg>
  );
}

export default function ModuleTabs({ tabs }: { tabs: ModuleTab[] }) {
  const pathname = usePathname() || "";
  const isActive = (t: ModuleTab) =>
    t.exact ? pathname === t.base : pathname === t.base || pathname.startsWith(t.base + "/");

  return (
    <nav
      className="flex gap-1 overflow-x-auto no-scrollbar rounded-2xl border border-[#EFE4D3] bg-white p-1.5 shadow-card"
      aria-label="โมดูล"
    >
      {tabs.map((t) => {
        const active = isActive(t);
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-2 whitespace-nowrap rounded-xl px-3.5 py-2 text-[13.5px] font-normal transition-colors ${
              active
                ? "bg-brand/10 text-brand-dark"
                : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"
            }`}
          >
            <Icon k={t.key} />
            {t.label}
            {t.badge ? (
              <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold leading-none text-white">
                {t.badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
