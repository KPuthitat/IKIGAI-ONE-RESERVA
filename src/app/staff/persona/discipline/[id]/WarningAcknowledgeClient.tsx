"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

// The acknowledge half of the staff disciplinary detail page.
//
// Two acknowledgment paths per the owner spec:
//   1. PIN-explicit: staff types their 4-digit PIN, taps "รับทราบ".
//   2. Auto-on-leave: staff opened the warning (we've already
//      written a view row in the parent server component) but tried
//      to leave without explicit ack — beforeunload fires a sendBeacon
//      POST to /api/persona/discipline/[id]/acknowledge with
//      method='auto_on_leave'. Server flips the row.
//
// We also record a view (independent of the server-side initial
// recordView in the parent page) when the component mounts so the
// audit log has a row pointing at the client-side timestamp too.

export default function WarningAcknowledgeClient({
  warningId, alreadyAcked
}: {
  warningId: number;
  alreadyAcked: boolean;
}) {
  const router = useRouter();
  const { t } = useLang();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [acked, setAcked] = useState(alreadyAcked);
  // Track whether an explicit ack has succeeded — if so, suppress
  // the auto-ack on leave (no race condition where the server flips
  // to "auto" right after the explicit one).
  const explicitAckedRef = useRef(alreadyAcked);
  // Track whether we've fired the auto-ack already so a page that
  // hides + reshows doesn't fire it twice.
  const autoAckSentRef = useRef(false);

  // 1. Append a view row on mount (in addition to the server-side
  //    initial view) so the audit log distinguishes the SSR page
  //    render from the client-side mount.
  useEffect(() => {
    if (alreadyAcked) return;
    fetch(apiUrl(`/api/persona/discipline/${warningId}/view`), {
      method: "POST"
    }).catch(() => { /* swallow — view logging is best-effort */ });
  }, [warningId, alreadyAcked]);

  // 2. Auto-ack on leave. We listen on both:
  //   • beforeunload — fires when staff closes the tab / hits the
  //     back button. sendBeacon survives the navigation.
  //   • visibilitychange → hidden — fires when staff swipes to
  //     another tab without closing. Captures swipe-away on mobile
  //     where beforeunload sometimes doesn't fire reliably.
  useEffect(() => {
    if (alreadyAcked) return;
    const fireAutoAck = (reason: string) => {
      if (explicitAckedRef.current) return;
      if (autoAckSentRef.current) return;
      autoAckSentRef.current = true;
      const url = apiUrl(`/api/persona/discipline/${warningId}/acknowledge`);
      const body = JSON.stringify({ method: "auto_on_leave", reason });
      // navigator.sendBeacon is the only API guaranteed to send
      // during page unload. Falls back to plain fetch if not
      // available (older browsers).
      if (typeof navigator !== "undefined" && navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      } else {
        // best-effort fetch — may not complete before unload
        fetch(url, {
          method: "POST",
          keepalive: true,
          headers: { "Content-Type": "application/json" },
          body
        }).catch(() => {});
      }
    };
    const onBeforeUnload = () => fireAutoAck("beforeunload");
    const onVisibility = () => {
      if (document.visibilityState === "hidden") fireAutoAck("visibility_hidden");
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [warningId, alreadyAcked]);

  async function submitPin() {
    setErr(null);
    if (pin.length !== 4) {
      setErr(t("staff.persona.discipline.pinInvalid"));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/persona/discipline/${warningId}/acknowledge`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "pin_explicit", pin })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        if (j.error === "wrong_pin") setErr(t("staff.persona.discipline.wrongPin"));
        else if (j.error === "no_pin_set") setErr(t("staff.persona.discipline.noPinSet"));
        else setErr(j.error ?? t("common.error"));
        return;
      }
      explicitAckedRef.current = true;
      setAcked(true);
      // Refresh server props so the page shows the "acknowledged"
      // banner without a hard reload.
      router.refresh();
    } finally { setBusy(false); }
  }

  if (acked) {
    return (
      <div className="card text-center space-y-2">
        <div className="text-5xl">✓</div>
        <h2 className="text-lg font-bold text-emerald-700">
          {t("staff.persona.discipline.thanks")}
        </h2>
        <p className="text-sm text-slate-600">
          {t("staff.persona.discipline.thanksBody")}
        </p>
      </div>
    );
  }

  return (
    <div className="card space-y-3 border-amber-300 bg-amber-50/30">
      <div>
        <h2 className="font-bold text-amber-900">
          ✋ {t("staff.persona.discipline.ackPrompt")}
        </h2>
        <p className="text-xs text-slate-600 mt-1">
          {t("staff.persona.discipline.ackHint")}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          inputMode="numeric"
          maxLength={4}
          className="input tracking-widest text-center text-lg w-32"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          placeholder="••••"
        />
        <button type="button"
          disabled={busy || pin.length !== 4}
          onClick={submitPin}
          className="flex-1 py-3 rounded-lg bg-rose-600 text-white font-bold disabled:opacity-50">
          {busy ? t("common.submitting") : "✓ " + t("staff.persona.discipline.ackButton")}
        </button>
      </div>
      {err && (
        <div className="text-sm text-rose-600">✗ {err}</div>
      )}
      <p className="text-[11px] text-slate-500">
        {t("staff.persona.discipline.autoAckWarning")}
      </p>
    </div>
  );
}
