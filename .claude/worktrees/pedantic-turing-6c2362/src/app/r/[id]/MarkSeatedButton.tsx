"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/i18n";

export default function MarkSeatedButton({
  bookingId, lang
}: { bookingId: number; lang: Lang }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function markSeated(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/admin/bookings/${bookingId}/status`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "seated" })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) {
        startTransition(() => router.refresh());
      } else {
        setErr(j?.error ?? t(lang, "common.error"));
        setBusy(false);
      }
    } catch {
      setErr(t(lang, "common.error"));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={markSeated}
        disabled={busy}
        className="w-full py-3 rounded-lg bg-brand hover:opacity-90 text-white font-bold text-base disabled:opacity-50"
      >
        {busy ? "…" : t(lang, "shortlink.markSeated")}
      </button>
      {err && <p className="text-rose-600 text-sm text-center">✗ {err}</p>}
    </div>
  );
}
