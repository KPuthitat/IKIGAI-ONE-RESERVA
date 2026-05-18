"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

// Module-picker–style cards: small uppercase label + big bold title +
// subdued helper line + brand-colored "เลือก →" CTA. The active branch
// gets a chip and brand-tinted border so returning users see at a
// glance where they last were. Whole card is the click target.
//
// Shared between /staff/branch-picker and /admin/branch-picker — both
// roles get the same UX (only the picker page wrapper + the layout
// chrome around it differs).

export default function BranchPickerClient({
  branches, activeBranchId, next
}: {
  branches: Array<{ id: number; name: string; company?: string | null }>;
  activeBranchId: number | null;
  next: string;
}) {
  const router = useRouter();
  const { t } = useLang();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function pick(id: number) {
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
        setErr(j.error || t("common.error"));
        return;
      }
      router.push(next);
      router.refresh();
    } catch {
      setErr(t("common.error"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="grid sm:grid-cols-2 gap-4">
        {branches.map((b) => {
          const isActive = b.id === activeBranchId;
          const isBusy = busyId === b.id;
          const dimOthers = busyId !== null && !isBusy;
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => pick(b.id)}
              disabled={busyId !== null}
              className={`card text-left transition group block relative ${
                isActive ? "ring-2 ring-brand/30 border border-brand/40" : ""
              } ${dimOthers ? "opacity-50" : "hover:shadow-2xl"}`}
            >
              <div className="flex items-center gap-2 mb-1">
                <div className="text-[11px] tracking-[1px] text-slate-400 uppercase">
                  {t("staff.branchPicker.branchLabel")}
                </div>
                {isActive && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-brand/10 text-brand tracking-[1px]">
                    {t("staff.branchPicker.activeChip")}
                  </span>
                )}
              </div>
              <h2 className="text-2xl font-bold text-slate-800 group-hover:text-brand transition-colors">
                {b.name}
              </h2>
              {b.company && (
                <div className="mt-0.5 text-xs text-slate-500 flex items-center gap-1">
                  <span aria-hidden>🏢</span>
                  {b.company}
                </div>
              )}
              <p className="mt-4 text-brand font-bold text-sm flex items-center gap-1">
                {isBusy ? t("common.submitting") : t("staff.branchPicker.cta")}
                {!isBusy && <span aria-hidden>→</span>}
              </p>
            </button>
          );
        })}
      </div>
      {err && (
        <div className="mt-4 text-sm text-rose-600 text-center">{err}</div>
      )}
    </>
  );
}
