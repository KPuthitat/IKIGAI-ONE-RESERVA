"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/i18n";

// Renders one of three states based on `initialStatus`:
//   'eligible' — code visible + green "เคลมไอติม" button.
//   'claimed'  — disabled checkmark banner with the claimed timestamp.
//   'expired'  — grey "หมดเวลาเคลมแล้ว" banner.
//   (NULL / 'not_eligible' — caller should not render this panel.)
//
// Staff visually confirms the code matches what the customer shows on
// their LINE Flex card BEFORE clicking the button. The button POSTs
// to /api/staff/redemption/claim with kind:'booking'.

type Status = "eligible" | "claimed" | "expired" | "not_eligible";

export default function ClaimIceCreamPanel({
  bookingId, code, initialStatus, claimedAt, lang
}: {
  bookingId: number;
  code: string | null;
  initialStatus: Status;
  claimedAt: string | null;
  lang: Lang;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [status, setStatus] = useState<Status>(initialStatus);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [doneAt, setDoneAt] = useState<string | null>(claimedAt);

  async function claim(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(apiUrl("/api/staff/redemption/claim"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "booking", id: bookingId })
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) {
        setStatus("claimed");
        setDoneAt(j.claimed_at ?? new Date().toISOString());
        startTransition(() => router.refresh());
      } else {
        setErr(j?.error ?? t(lang, "common.error"));
      }
    } catch {
      setErr(t(lang, "common.error"));
    }
    setBusy(false);
  }

  if (status === "claimed") {
    return (
      <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-4 text-center">
        <div className="text-emerald-700 font-bold text-sm">
          ✓ {t(lang, "shortlink.claimedTitle")}
        </div>
        {doneAt && (
          <div className="text-xs text-emerald-600 mt-1">
            {hhmmFromIso(doneAt)}
          </div>
        )}
      </div>
    );
  }

  if (status === "expired") {
    return (
      <div className="rounded-lg bg-slate-100 border border-slate-200 p-3 text-center text-sm text-slate-500">
        {t(lang, "shortlink.expiredTitle")}
      </div>
    );
  }

  // eligible
  return (
    <div className="rounded-lg bg-amber-50 border border-amber-300 p-4 space-y-3">
      <div className="text-center">
        <div className="text-sm font-bold text-amber-800 mb-1">
          {t(lang, "shortlink.eligibleTitle")}
        </div>
        <div className="text-xs text-amber-700">
          {t(lang, "shortlink.eligibleHint")}
        </div>
      </div>
      {code && (
        <div className="bg-white border border-amber-300 rounded-lg p-3 text-center">
          <div className="text-[10px] text-slate-500 mb-0.5">
            {t(lang, "shortlink.codeLabel")}
          </div>
          <div className="text-2xl font-bold text-slate-800 tracking-widest">
            {code}
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={claim}
        disabled={busy}
        className="w-full py-3 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-bold text-base disabled:opacity-50"
      >
        {busy ? "…" : t(lang, "shortlink.claimBtn")}
      </button>
      {err && <p className="text-rose-600 text-sm text-center">✗ {err}</p>}
    </div>
  );
}

function hhmmFromIso(iso: string): string {
  const bkk = new Date(new Date(iso).getTime() + 7 * 60 * 60 * 1000);
  return bkk.toISOString().slice(11, 16);
}
