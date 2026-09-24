"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { apiUrl } from "@/lib/url";

// Deep, branch-scoped DETAIL pages belong to the OLD branch, so staying on
// them after a switch shows another branch's record (or 404s). Collapse
// those to their section home — same rule as TodaysBranchPill. Extend as
// more detail sections appear.
const COLLAPSE_ROOTS = ["/admin/persona/payroll"];

// Branch selector styled exactly like ModuleTabs (owner 2026-09-24:
// "อยากได้ปุ่มเลือกสาขาแบบเดียวกับปุ่มเลือกโมดูล"). A horizontal, scrollable row
// of branch pills; the active branch is highlighted. Tapping a branch
// switches the session's active branch (POST /api/branch — the same
// endpoint the full-page branch picker uses) and refreshes in place, so
// the user stays on the current page under the new branch.
//
// Self-hides when the user has 0-1 branches (no choice to make).

export type BranchTab = { id: number; name: string };

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-[17px] h-[17px] flex-shrink-0" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 21s7-5.2 7-11a7 7 0 10-14 0c0 5.8 7 11 7 11z" />
      <circle cx="12" cy="10" r="2.5" />
    </svg>
  );
}

export default function BranchTabs({
  branches, activeBranchId
}: {
  branches: BranchTab[];
  activeBranchId: number | null;
}) {
  const router = useRouter();
  const pathname = usePathname() || "";
  const [busyId, setBusyId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const navRef = useRef<HTMLElement>(null);
  const [showFade, setShowFade] = useState(false);
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const update = () => {
      const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
      setShowFade(el.scrollWidth > el.clientWidth + 1 && !atEnd);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [branches.length]);

  if (branches.length <= 1) return null;

  async function pick(id: number) {
    if (id === activeBranchId || busyId !== null) return;
    setBusyId(id);
    setErr(null);
    try {
      const res = await fetch(apiUrl("/api/branch"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch_id: id })
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr(j.error || "สลับสาขาไม่สำเร็จ");
        return;
      }
      // A deep detail page belongs to the old branch — land on its section
      // home instead of 404ing; otherwise just refresh in place.
      const collapsed = COLLAPSE_ROOTS.find((r) => pathname.startsWith(r + "/"));
      if (collapsed) router.push(collapsed);
      router.refresh();
    } catch {
      setErr("สลับสาขาไม่สำเร็จ");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="relative">
      <nav
        ref={navRef}
        className="flex gap-1 overflow-x-auto no-scrollbar rounded-2xl border border-[#EFE4D3] bg-white p-1.5 shadow-card"
        aria-label="สาขา"
      >
        {branches.map((b) => {
          const active = b.id === activeBranchId;
          const busy = busyId === b.id;
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => pick(b.id)}
              disabled={busyId !== null}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-2 whitespace-nowrap rounded-xl px-3.5 py-2 text-[13.5px] font-normal transition-colors ${
                active
                  ? "bg-brand/10 text-brand-dark"
                  : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"
              } ${busyId !== null && !busy ? "opacity-50" : ""}`}
            >
              <PinIcon />
              {b.name}
            </button>
          );
        })}
      </nav>
      {showFade && (
        <div className="pointer-events-none absolute inset-y-1.5 right-1.5 w-8 rounded-r-2xl bg-gradient-to-l from-white to-transparent" aria-hidden />
      )}
      {err && <div className="mt-1 px-2 text-xs text-rose-600">{err}</div>}
    </div>
  );
}
