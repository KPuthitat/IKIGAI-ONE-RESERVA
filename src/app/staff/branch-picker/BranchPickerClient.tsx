"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

// Big-button picker — one card per branch. Tap → POST /api/branch
// → router.push(next). The currently-active branch (if any) gets a
// "active" chip so returning users can see what's already set.

export default function BranchPickerClient({
  branches, activeBranchId, next
}: {
  branches: Array<{ id: number; name: string }>;
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
    <div className="space-y-3">
      {branches.map((b) => {
        const isActive = b.id === activeBranchId;
        const isBusy = busyId === b.id;
        return (
          <button
            key={b.id}
            type="button"
            onClick={() => pick(b.id)}
            disabled={busyId !== null}
            className={`w-full card text-left transition hover:shadow-2xl hover:border-brand ${
              isActive ? "border-brand ring-2 ring-brand/20" : ""
            } ${busyId !== null && !isBusy ? "opacity-50" : ""}`}
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] tracking-[1px] text-slate-400 uppercase">
                  {t("staff.branchPicker.branchLabel")}
                </div>
                <div className="text-xl font-bold text-slate-800 mt-0.5">{b.name}</div>
              </div>
              <div className="flex items-center gap-2">
                {isActive && (
                  <span className="text-[10px] px-2 py-1 rounded-full bg-brand/10 text-brand font-bold tracking-[1px]">
                    {t("staff.branchPicker.activeChip")}
                  </span>
                )}
                <span className="text-brand text-2xl">→</span>
              </div>
            </div>
            {isBusy && (
              <div className="mt-2 text-xs text-slate-400">{t("common.submitting")}</div>
            )}
          </button>
        );
      })}
      {err && <div className="text-sm text-rose-600 text-center">{err}</div>}
    </div>
  );
}
