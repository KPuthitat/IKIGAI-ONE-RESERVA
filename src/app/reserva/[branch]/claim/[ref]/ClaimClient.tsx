"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Script from "next/script";
import { apiUrl } from "@/lib/url";
import { t as tServer } from "@/lib/i18n";
import type { Lang } from "@/lib/i18n";

// Customer-facing claim flow. The page server-renders the booking summary
// (above this component); this component handles:
//   1. Silent LIFF init + getProfile to capture line_user_id behind the
//      scenes (no auto-claim — we wait for the user to tap "Confirm").
//   2. Optional marketing chips (origin / source / member status) that
//      admin couldn't fill when entering the booking on the customer's
//      behalf. Customer can leave them all blank.
//   3. A single "Confirm and get QR Code" button → POST claim → Flex
//      card pushed to customer's LINE → success state with link to view
//      the booking detail (which has the QR).
//
// Lifecycle states:
//   "loading"   → LIFF SDK still loading or getProfile in flight
//   "auth"      → liff.login() in progress (only fires in external browser)
//   "ready"     → form rendered + button enabled (LIFF userId in hand)
//   "claiming"  → POST /api/bookings/claim in flight
//   "linked"    → success: Flex card pushed
//   "already"   → booking already linked to this user; show success too
//   "error"     → LIFF init failed / claim API error / different user

import "@/lib/liff-types";

type State =
  | { kind: "loading" }
  | { kind: "auth" }
  | { kind: "ready"; userId: string }
  | { kind: "claiming" }
  | { kind: "linked" }
  | { kind: "already" }
  | { kind: "error"; reason: string; detail?: string };

// Source/origin chip values mirror the customer booking form so admin
// dashboards group everything correctly. Keep keys in sync with
// SOURCE_DEFS / ORIGIN_DEFS in BookingForm.tsx.
const SOURCE_DEFS: Array<{ value: string; key: string }> = [
  { value: "Instagram", key: "booking.source.Instagram" },
  { value: "Facebook", key: "booking.source.Facebook" },
  { value: "TikTok", key: "booking.source.TikTok" },
  { value: "Google Maps", key: "booking.source.GoogleMaps" },
  { value: "เพื่อนแนะนำ", key: "booking.source.friend" },
  { value: "ผ่านมาเห็น", key: "booking.source.passing" },
  { value: "อื่นๆ", key: "booking.source.other" }
];
const ORIGIN_DEFS: Array<{ value: string; key: string }> = [
  { value: "sriracha", key: "booking.origin.sriracha" },
  { value: "chonburi", key: "booking.origin.chonburi" },
  { value: "other_province", key: "booking.origin.other_province" }
];

export default function ClaimClient({
  ref_no, branchSlug, liffId, alreadyLinked, lang
}: {
  ref_no: string;
  branchSlug: string;
  liffId: string | null;
  alreadyLinked: boolean;
  lang: Lang;
}) {
  // branchSlug is currently unused at runtime — accepted as a prop only
  // so the URL/branch contract stays explicit if a future revision needs
  // to deep-link back into the branch's booking form.
  void branchSlug;

  const [state, setState] = useState<State>({ kind: "loading" });
  const [sdkReady, setSdkReady] = useState(false);

  // Marketing chip state — all optional, all start blank.
  const [origin, setOrigin] = useState<string>("");
  const [sources, setSources] = useState<string[]>([]);
  const [isMember, setIsMember] = useState<"" | "0" | "1">("");
  // PDPA consent — must be checked before the "Confirm" button submits
  // the LINE userId + marketing answers. The userId itself is captured
  // by LIFF silently at page load (LINE's own permission flow already
  // applies on first visit), but we don't TRANSMIT it to our server
  // without an explicit consent tap here.
  const [pdpaConsent, setPdpaConsent] = useState(false);

  function tt(key: string, vars?: Record<string, string | number>): string {
    return tServer(lang, key, vars);
  }

  // ── Step 1: silent LIFF login → capture userId ────────────────────
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
          liff.login();
          return;
        }
        const profile = await liff.getProfile();
        if (cancelled) return;
        setState({ kind: "ready", userId: profile.userId });
      } catch (e: unknown) {
        if (!cancelled) {
          const detail = e instanceof Error ? e.message : String(e);
          setState({ kind: "error", reason: "exception", detail });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [sdkReady, liffId]);

  // ── Step 2: customer taps "Confirm and get QR" ────────────────────
  async function submitClaim() {
    if (state.kind !== "ready") return;
    if (!pdpaConsent) return;                  // belt-and-braces — button is also disabled
    const userId = state.userId;
    setState({ kind: "claiming" });
    try {
      const res = await fetch(apiUrl("/api/bookings/claim"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ref: ref_no,
          line_user_id: userId,
          customer_origin: origin || null,
          source: sources.length > 0 ? JSON.stringify(sources) : null,
          is_member: isMember === "" ? null : (Number(isMember) as 0 | 1)
        })
      });
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
      setState({ kind: data.already_linked ? "already" : "linked" });
    } catch (e: unknown) {
      const detail = e instanceof Error ? e.message : String(e);
      setState({ kind: "error", reason: "exception", detail });
    }
  }

  return (
    <>
      {liffId && (
        <Script
          src="https://static.line-scdn.net/liff/edge/2/sdk.js"
          strategy="afterInteractive"
          onLoad={() => setSdkReady(true)}
        />
      )}

      {(state.kind === "loading" || state.kind === "auth") && (
        <StatusCard
          tone="info"
          title={tt(state.kind === "auth"
            ? "claim.state.auth.title"
            : "claim.state.init.title")}
          body={tt(state.kind === "auth"
            ? "claim.state.auth.body"
            : "claim.state.init.body")}
        />
      )}

      {state.kind === "ready" && (
        <div className="space-y-4">
          {alreadyLinked && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-900 text-sm p-3">
              {tt("claim.alreadyLinkedHint")}
            </div>
          )}

          <div className="space-y-3">
            <div className="text-xs font-bold text-slate-600 tracking-wider uppercase">
              {tt("claim.marketing.title")}
            </div>
            <div className="text-xs text-slate-500">
              {tt("claim.marketing.subtitle")}
            </div>

            <div>
              <div className="text-xs font-semibold text-slate-500 mb-1.5">
                {tt("booking.field.origin")}
              </div>
              <ChipGroup
                options={ORIGIN_DEFS.map((o) => ({ value: o.value, label: tt(o.key) }))}
                value={origin}
                onChange={(v) => setOrigin(v ?? "")}
              />
            </div>

            <div>
              <div className="text-xs font-semibold text-slate-500 mb-1.5">
                {tt("booking.field.source")}
              </div>
              <MultiChipGroup
                options={SOURCE_DEFS.map((s) => ({ value: s.value, label: tt(s.key) }))}
                values={sources}
                onChange={setSources}
              />
            </div>

            <div>
              <div className="text-xs font-semibold text-slate-500 mb-1.5">
                {tt("booking.field.member")}
              </div>
              <ChipGroup
                options={[
                  { value: "1", label: tt("booking.member.yes") },
                  { value: "0", label: tt("booking.member.no") }
                ]}
                value={isMember}
                onChange={(v) => setIsMember(v === null ? "" : (v as "0" | "1"))}
              />
            </div>
          </div>

          {/* PDPA consent — required (Thailand Personal Data
              Protection Act 2019, sect. 19/24). Submit button
              stays disabled until checked. */}
          <label className="flex items-start gap-2 text-xs text-slate-700 border border-slate-200 rounded-lg p-3 bg-slate-50">
            <input
              type="checkbox"
              checked={pdpaConsent}
              onChange={(e) => setPdpaConsent(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              {tt("claim.pdpa.consent")}{" "}
              <Link href="/privacy" target="_blank" className="text-brand underline">
                {tt("claim.pdpa.policyLink")}
              </Link>
            </span>
          </label>

          <button
            type="button"
            onClick={submitClaim}
            disabled={!pdpaConsent}
            className="btn-primary w-full text-base py-3.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {tt("claim.cta.confirm")}
          </button>
        </div>
      )}

      {state.kind === "claiming" && (
        <StatusCard
          tone="info"
          title={tt("claim.state.claiming.title")}
          body={tt("claim.state.claiming.body")}
        />
      )}

      {(state.kind === "linked" || state.kind === "already") && (
        <StatusCard
          tone="success"
          title={tt(state.kind === "linked"
            ? "claim.state.linked.title"
            : "claim.state.already.title")}
          body={tt(state.kind === "linked"
            ? "claim.state.linked.body"
            : "claim.state.already.body")}
          cta={
            <Link
              href={`/r/${ref_no}`}
              className="btn-primary inline-block w-full text-center"
            >
              {tt("claim.state.linked.cta")}
            </Link>
          }
        />
      )}

      {state.kind === "error" && (
        <StatusCard
          tone="danger"
          title={tt(`claim.error.${state.reason}.title`)}
          body={
            state.detail
              ? `${tt(`claim.error.${state.reason}.body`)}\n\n[${state.detail}]`
              : tt(`claim.error.${state.reason}.body`)
          }
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

// ── Chip controls (mirrors BookingForm.tsx) ───────────────────────────
function ChipGroup({
  options, value, onChange
}: {
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (v: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const selected = value === o.value;
        return (
          <button
            type="button"
            key={o.value}
            onClick={() => onChange(selected ? null : o.value)}
            className={`px-3.5 py-2 rounded-full text-sm border-[1.5px] transition min-h-[40px] ${
              selected
                ? "bg-brand text-white border-brand shadow-sm"
                : "bg-white text-slate-600 border-slate-200 hover:border-brand/60 active:scale-95"
            }`}
          >{o.label}</button>
        );
      })}
    </div>
  );
}

function MultiChipGroup({
  options, values, onChange
}: {
  options: Array<{ value: string; label: string }>;
  values: string[];
  onChange: (vs: string[]) => void;
}) {
  function toggle(v: string) {
    if (values.includes(v)) onChange(values.filter((x) => x !== v));
    else onChange([...values, v]);
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const selected = values.includes(o.value);
        return (
          <button
            type="button"
            key={o.value}
            onClick={() => toggle(o.value)}
            className={`px-3.5 py-2 rounded-full text-sm border-[1.5px] transition min-h-[40px] ${
              selected
                ? "bg-brand text-white border-brand shadow-sm"
                : "bg-white text-slate-600 border-slate-200 hover:border-brand/60 active:scale-95"
            }`}
          >
            {selected && <span className="mr-1">✓</span>}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
