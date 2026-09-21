"use client";

// Per-employee "ตรวจแล้ว" sign-off on the company-cycle page (owner 2026-09-21:
// "อยากได้ปุ่ม ตรวจแล้ว ที่หน้านี้ด้วย"). Mirrors the per-period detail toggle, but a
// person on the cycle can span two branch-periods, so one click marks every one
// of their DRAFT-period lines reviewed (the review route is per period + user).
// Finalized/paid lines are frozen and past review, so the button is hidden for
// people with no draft line left.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

export default function LineReviewToggle({
  userId, draftPeriodIds, reviewed
}: {
  userId: number;
  draftPeriodIds: number[];
  reviewed: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const [, startTransition] = useTransition();

  if (draftPeriodIds.length === 0) return null;   // locked (finalized/paid) — review not applicable

  async function toggle() {
    setBusy(true);
    setErr(false);
    const want = !reviewed;
    try {
      for (const pid of draftPeriodIds) {
        const res = await fetch(
          apiUrl(`/api/admin/persona/payroll/periods/${pid}/lines/${userId}/review`),
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reviewed: want }) }
        );
        if (!res.ok) throw new Error();
      }
    } catch {
      setErr(true);
    } finally {
      setBusy(false);
      // Always resync — a multi-branch person may have had some (not all) of their
      // period lines updated before a failure, so pull the real state either way.
      startTransition(() => router.refresh());
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      className={`mt-1 inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border transition disabled:opacity-50 ${
        reviewed
          ? "border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
          : "border-slate-300 text-slate-500 hover:bg-slate-50"
      }`}
      title={reviewed ? "กดเพื่อยกเลิกการตรวจ" : "กดเมื่อตรวจค่าตอบแทนของคนนี้แล้ว"}
    >
      {busy ? "…" : reviewed ? "✓ ตรวจแล้ว" : "ตรวจแล้ว"}
      {err && <span className="text-rose-600">!</span>}
    </button>
  );
}
