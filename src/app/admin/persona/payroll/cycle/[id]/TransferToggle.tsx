"use client";

// Per-employee "ทำรายการแล้ว" tick on the company-cycle page (owner 2026-10-19): the admin ticks a person once
// their pay has really been transferred; pay-all / post-all stay locked until everyone is ticked. A person can
// span two branch-periods, so one click updates every finalized/paid, not-yet-posted line of theirs.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

export default function TransferToggle({
  userId, periodIds, done, locked
}: {
  userId: number;
  periodIds: number[];
  done: boolean;
  locked: boolean;   // already posted to the books — frozen
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (periodIds.length === 0) return null;
  if (locked) {
    return done
      ? <span className="mt-1 inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border border-sky-300 bg-sky-50 text-sky-700">✓ ทำรายการแล้ว</span>
      : null;
  }

  async function toggle() {
    setBusy(true); setErr(null);
    try {
      for (const pid of periodIds) {
        const res = await fetch(apiUrl(`/api/admin/persona/payroll/periods/${pid}/lines/${userId}/transfer`), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ done: !done })
        });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.message ?? "บันทึกไม่สำเร็จ"); }
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      startTransition(() => router.refresh());
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button" onClick={toggle} disabled={busy}
        className={`mt-1 inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border transition disabled:opacity-50 ${
          done ? "border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100" : "border-slate-300 text-slate-500 hover:bg-slate-50"
        }`}
        title={done ? "กดเพื่อยกเลิก" : "กดเมื่อทำรายการโอนค่าตอบแทนของคนนี้แล้ว"}
      >
        {busy ? "…" : done ? "✓ ทำรายการแล้ว" : "ทำรายการแล้ว"}
      </button>
      {err && <span className="text-[11px] text-rose-600">{err}</span>}
    </span>
  );
}
