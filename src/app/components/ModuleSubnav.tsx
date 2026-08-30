"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { SidebarSection } from "./Sidebar";

// Contextual sub-navigation for the active module (redesign 2026-08).
// Replaces the lower (pathPrefix-scoped) sections of the old dark sidebar.
//
// Two render modes off the same data:
//   • mode="list"  — vertical card, shown as a left column on md+.
//   • mode="chips" — horizontal scrollable pills, shown above the page
//     content on mobile (where a left rail would eat the width).
//
// Active detection mirrors the old Sidebar exactly, including the
// query-string awareness that distinguishes checklist editor siblings
// sharing a route but differing by ?type= (shift_open / shift_close /
// readiness_*). We read window.location.search via a patched history
// event rather than useSearchParams() so we don't force parent pages
// into client rendering.

export default function ModuleSubnav({
  sections,
  mode
}: {
  sections: SidebarSection[];
  mode: "list" | "chips";
}) {
  const pathname = usePathname() || "";
  const [currentQuery, setCurrentQuery] = useState<string>("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = () => setCurrentQuery(window.location.search);
    sync();
    const w = window as typeof window & { __ikigaiNavPatched?: boolean };
    if (!w.__ikigaiNavPatched) {
      w.__ikigaiNavPatched = true;
      const origPush = history.pushState;
      const origReplace = history.replaceState;
      history.pushState = function (...args: Parameters<History["pushState"]>) {
        origPush.apply(this, args);
        window.dispatchEvent(new Event("ikigai:urlchange"));
      };
      history.replaceState = function (...args: Parameters<History["replaceState"]>) {
        origReplace.apply(this, args);
        window.dispatchEvent(new Event("ikigai:urlchange"));
      };
    }
    window.addEventListener("ikigai:urlchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("ikigai:urlchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, [pathname]);

  function isActive(href: string): boolean {
    const [itemPath, itemQuery] = href.split("?");
    if (href === "/admin" || href === "/staff") return pathname === href;
    if (itemPath !== pathname) return pathname.startsWith(itemPath + "/");
    if (itemQuery) {
      const itemParams = new URLSearchParams(itemQuery);
      const urlParams = new URLSearchParams(currentQuery);
      for (const [k, v] of itemParams) {
        if (urlParams.get(k) !== v) return false;
      }
      return true;
    }
    return true;
  }

  const visible = sections.filter(
    (s) => !s.pathPrefix || pathname === s.pathPrefix || pathname.startsWith(s.pathPrefix + "/")
  );
  const items = visible.flatMap((s) => s.items);
  if (items.length === 0) return null;

  const showBadge = (b: number | string | undefined) =>
    b !== undefined && b !== 0 && b !== "0" && b !== "";

  if (mode === "chips") {
    // Mobile: a scrollable pill row inside a white card — same shell + pill
    // style as the main module tab bar (owner 2026-08: sub-nav should read
    // like the primary nav). Section headings dropped; the tab bar already
    // names the module.
    return (
      <nav
        className="flex gap-1 overflow-x-auto no-scrollbar rounded-2xl border border-[#EFE4D3] bg-white p-1.5 shadow-card"
        aria-label="เมนูย่อย"
      >
        {items.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-2 whitespace-nowrap rounded-xl px-3.5 py-2 text-[13.5px] font-normal transition-colors ${
                active
                  ? "bg-brand/10 text-brand-dark"
                  : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"
              }`}
            >
              {item.label}
              {showBadge(item.badge) && (
                <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold leading-none text-white">
                  {item.badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    );
  }

  // Desktop: grouped vertical list in a card.
  return (
    <nav className="rounded-2xl border border-[#EFE4D3] bg-white p-2.5 shadow-card" aria-label="เมนูย่อย">
      {visible.map((s, i) => (
        <div key={i} className={i > 0 ? "mt-3" : ""}>
          {s.label && (
            <div className="px-2.5 pb-1.5 pt-2 text-[10.5px] font-bold uppercase tracking-[0.12em] text-slate-400">
              {s.label}
            </div>
          )}
          <ul className="space-y-0.5">
            {s.items.map((item) => {
              const active = isActive(item.href);
              const base = active
                ? "bg-brand/10 text-brand-dark font-semibold"
                : item.legacy
                ? "text-amber-700/80 hover:bg-amber-50 hover:text-amber-800"
                : "text-slate-600 hover:bg-slate-50 hover:text-slate-900 font-medium";
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`flex items-center gap-2 rounded-xl px-2.5 py-2 text-[13.5px] transition-colors ${base}`}
                  >
                    <span className="flex-1 truncate">{item.label}</span>
                    {showBadge(item.badge) && (
                      <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-bold leading-none text-white">
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
  );
}
