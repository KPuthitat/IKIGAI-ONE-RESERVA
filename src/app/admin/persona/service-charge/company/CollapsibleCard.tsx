"use client";

import { useEffect, useState, type ReactNode } from "react";

// A card whose body can be hidden (owner 2026-10-20: เบี้ยประชุมซ่อนได้). The title and the one-line summary stay
// visible; the choice is remembered in this browser.
export default function CollapsibleCard({ storageKey, title, aside, children }: {
  storageKey: string; title: string; aside?: ReactNode; children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { try { if (localStorage.getItem(storageKey) === "1") setCollapsed(true); } catch { /* storage blocked */ } }, [storageKey]);
  const toggle = () => setCollapsed((c) => { const n = !c; try { localStorage.setItem(storageKey, n ? "1" : "0"); } catch { /* storage blocked */ } return n; });
  return (
    <div className="card">
      <div className={`flex items-center justify-between gap-2 flex-wrap ${collapsed ? "" : "mb-2"}`}>
        <div className="text-sm font-bold text-slate-700">{title}</div>
        <div className="flex items-center gap-2">
          {aside && <div className="text-xs text-slate-500">{aside}</div>}
          <button type="button" onClick={toggle} aria-expanded={!collapsed}
            className="text-xs px-2.5 py-1 rounded-full border border-slate-300 text-slate-600 hover:bg-slate-50 whitespace-nowrap">
            {collapsed ? "แสดง ▾" : "ซ่อน ▴"}
          </button>
        </div>
      </div>
      {!collapsed && children}
    </div>
  );
}
