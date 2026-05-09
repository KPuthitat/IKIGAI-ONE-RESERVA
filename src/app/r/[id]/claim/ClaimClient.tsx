"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Script from "next/script";
import { apiUrl } from "@/lib/url";
import { t as tServer } from "@/lib/i18n";
import type { Lang } from "@/lib/i18n";

// Client component that runs the LIFF init → claim flow. Mounted from the
// server `/r/<ref>/claim` page once the booking is loaded.
//
// Lifecycle:
//   "init"      → LIFF SDK still loading
//   "auth"      → liff.login() in progress (only fires in external browser)
//   "claiming"  → POST /api/bookings/claim in flight
//   "linked"    → Flex card pushed; show "check your LINE chat" message
//   "already"   → booking was already linked to this LINE account; show OK
//   "error"     → something went wrong (usually no LIFF configured)

// The window.liff global type lives in lib/liff-types — importing it here
// just so the ambient `declare global` runs (no value imported).
import "@/lib/liff-types";

type State =
  | { kind: "init" }
  | { kind: "auth" }
  | { kind: "claiming" }
  | { kind: "linked" }
  | { kind: "already" }
  | { kind: "error"; reason: string };

export default function ClaimClient({
  ref_no, liffId, alreadyLinked, lang
}: {
  ref_no: string;
  liffId: string | null;
  /** True if the booking already has a line_user_id on the server side.
   *  We still let LIFF run so we can show "already linked" once we confirm
   *  it's the same user — but skip the API call in that case. */
  alreadyLinked: boolean;
  lang: Lang;
}) {
  const [state, setState] = useState<State>({ kind: "init" });
  const [sdkReady, setSdkReady] = useState(false);

  // Quick local i18n to avoid plumbing useLang into a server-rendered module.
  function tt(key: string): string {
    return tServer(lang, key);
  }

  useEffect(() => {
    if (!sdkReady) return;
    if (!liffId) {
      setState({ kind: "error", reason: "no_liff" });
      return;
    }
    const liff = typeof window !== "undefined" ? window.liff : undefined;
    if (!liff) {
      setState({ kind: "error", reason: "no_sdk" });
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        await liff.init({ liffId });
        if (cancelled) return;
        if (!liff.isLoggedIn()) {
          setState({ kind: "auth" });
          // Triggers redirect to LINE login → comes back here
          liff.login();
          return;
        }
        const profile = await liff.getProfile();
        if (cancelled) return;
        setState({ kind: "claiming" });
        const res = await fetch(apiUrl("/api/bookings/claim"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ref: ref_no,
            line_user_id: profile.userId
          })
        });
        if (cancelled) return;
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (data.error === "already_claimed") {
            setState({ kind: "error", reason: "already_claimed" });
            return;
          }
          if (data.error === "booking_closed") {
            setState({ kind: "error", reason: "booking_closed" });
            return;
          }
          setState({ kind: "error", reason: "api_failed" });
          return;
        }
        if (data.already_linked) {
          setState({ kind: "already" });
        } else {
          setState({ kind: "linked" });
        }
      } catch {
        if (!cancelled) setState({ kind: "error", reason: "exception" });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdkReady, liffId, ref_no, alreadyLinked]);

  return (
    <>
      {liffId && (
        <Script
          src="https://static.line-scdn.net/liff/edge/2/sdk.js"
          strategy="afterInteractive"
          onLoad={() => setSdkReady(true)}
        />
      )}

      {state.kind === "init" && (
        <StatusCard
          tone="info"
          title={tt("claim.state.init.title")}
          body={tt("claim.state.init.body")}
        />
      )}

      {state.kind === "auth" && (
        <StatusCard
          tone="info"
          title={tt("claim.state.auth.title")}
          body={tt("claim.state.auth.body")}
        />
      )}

      {state.kind === "claiming" && (
        <StatusCard
          tone="info"
          title={tt("claim.state.claiming.title")}
          body={tt("claim.state.claiming.body")}
        />
      )}

      {state.kind === "linked" && (
        <StatusCard
          tone="success"
          title={tt("claim.state.linked.title")}
          body={tt("claim.state.linked.body")}
          cta={
            <Link href={`/r/${ref_no}`} className="btn-primary inline-block w-full text-center">
              {tt("claim.state.linked.cta")}
            </Link>
          }
        />
      )}

      {state.kind === "already" && (
        <StatusCard
          tone="success"
          title={tt("claim.state.already.title")}
          body={tt("claim.state.already.body")}
          cta={
            <Link href={`/r/${ref_no}`} className="btn-primary inline-block w-full text-center">
              {tt("claim.state.already.cta")}
            </Link>
          }
        />
      )}

      {state.kind === "error" && (
        <StatusCard
          tone="danger"
          title={tt(`claim.error.${state.reason}.title`)}
          body={tt(`claim.error.${state.reason}.body`)}
        />
      )}
    </>
  );
}

function StatusCard({
  tone, title, body, cta
}: {
  tone: "info" | "success" | "danger";
  title: string;
  body: string;
  cta?: React.ReactNode;
}) {
  const toneCls =
    tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-900"
    : tone === "danger" ? "border-rose-200 bg-rose-50 text-rose-900"
    : "border-sky-200 bg-sky-50 text-sky-900";
  return (
    <div className={`rounded-xl border p-4 space-y-2 ${toneCls}`}>
      <div className="font-bold">{title}</div>
      <div className="text-sm whitespace-pre-line">{body}</div>
      {cta && <div className="pt-2">{cta}</div>}
    </div>
  );
}
