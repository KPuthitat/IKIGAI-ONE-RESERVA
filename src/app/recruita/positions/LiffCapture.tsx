"use client";

import { useEffect, useRef } from "react";
import Script from "next/script";
import "@/lib/liff-types";

// /recruita/positions is the public LIFF endpoint for the apply
// flow. When candidates tap the rich-menu "สมัครงาน" button, LINE
// lands them here carrying ?liff.state=… . We are the FIRST page
// they hit inside LIFF context, so this is where we must consume
// that state — once they click a position card and navigate to
// /apply/[id], Next.js soft-nav drops liff.state from the URL and
// ApplyClient can no longer establish a fresh session there.
//
// What we capture:
//   - profile.userId      — links the future application row to
//                           a LINE account so stage-change pushes
//                           land in the right inbox.
//   - profile.displayName — pre-fills the name field in
//                           ApplyClient. Saves the candidate from
//                           typing what we already know.
//
// We stash these in sessionStorage under a stable key. ApplyClient
// reads + clears on submit. sessionStorage (not localStorage)
// because we want the prefill to expire when the tab closes — a
// shared device shouldn't leak the previous user's name into the
// next applicant's form.

const STORAGE_KEY = "recruita_liff_profile_v1";

export type StoredLiffProfile = {
  userId: string;
  displayName: string;
  pictureUrl?: string;
  capturedAt: number; // ms epoch — for staleness checks downstream
};

export default function LiffCapture({ liffId }: { liffId: string | null }) {
  const ranRef = useRef(false);

  async function run() {
    if (!liffId || ranRef.current) return;
    ranRef.current = true;
    // Only proceed inside LINE's in-app browser (UA "Line/x.x"). With the
    // LIFF Endpoint URL now set to /recruita (covering this page), every
    // /recruita/* page is inside the LIFF session, so we no longer require
    // ?liff.state in the URL — that guard dropped the capture after the
    // /recruita → /recruita/positions redirect (owner 2026-06-15). We still
    // never call liff.login() here, so a not-logged-in case just returns —
    // no access.line.me redirect, no 400.
    const inLineApp = /Line\/[\d.]+/i.test(navigator.userAgent);
    if (!inLineApp) return;
    try {
      const w = window as unknown as { liff?: typeof window.liff };
      if (!w.liff) return;
      // Tolerate a re-init — the SDK may already be initialised.
      try { await w.liff.init({ liffId }); } catch { /* already initialized */ }
      if (!w.liff.isLoggedIn()) return;
      const profile = await w.liff.getProfile();
      if (!profile?.userId) return;
      const payload: StoredLiffProfile = {
        userId: profile.userId,
        displayName: profile.displayName,
        pictureUrl: profile.pictureUrl,
        capturedAt: Date.now()
      };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
      // Swallow — capture is best-effort. The form still works
      // without it; the candidate just types more.
      console.warn("[recruita] LiffCapture failed:", e);
    }
  }

  useEffect(() => {
    if (!liffId) return;
    const w = window as unknown as { liff?: typeof window.liff };
    if (w.liff) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liffId]);

  if (!liffId) return null;
  return (
    <Script
      src="https://static.line-scdn.net/liff/edge/2/sdk.js"
      strategy="afterInteractive"
      onLoad={run} />
  );
}

export { STORAGE_KEY as LIFF_PROFILE_STORAGE_KEY };
