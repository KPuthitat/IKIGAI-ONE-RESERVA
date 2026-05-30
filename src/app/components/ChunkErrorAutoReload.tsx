"use client";

// ChunkLoadError auto-reload.
//
// Background: when we deploy, `rm -rf .next` wipes the old build
// chunks and the new build emits chunks with NEW hashes. Anyone
// whose browser is mid-session at deploy time has the OLD HTML
// cached, which references chunk URLs that don't exist anymore.
// The next dynamic-import → 404 → React throws `ChunkLoadError` →
// Next.js' default error boundary shows "Application error: a
// client-side exception has occurred".
//
// The 2026-05-30 dinner-shift incident hit this. Fix: catch the
// specific error class and reload the page once — the reload picks
// up the new HTML which points at the new chunks.
//
// Two layers of catch:
//   1. window 'error' event for ChunkLoadError (top-level script
//      load failures)
//   2. window 'unhandledrejection' for failed dynamic imports
//      (most common path in app-router)
//
// Reload guard: we stamp sessionStorage so a hard-broken build
// can't trap the user in an infinite reload loop. If the same
// session already reloaded for a chunk error in the last 30s, we
// stop — fall through to the default Next.js error boundary so
// the operator sees something actionable.

import { useEffect } from "react";

const SESSION_KEY = "ikigai-chunk-reload-ts";
const COOLDOWN_MS = 30_000;

function isChunkLoadError(err: unknown): boolean {
  if (!err) return false;
  const message = (err as { message?: string })?.message ?? String(err);
  const name = (err as { name?: string })?.name ?? "";
  return (
    name === "ChunkLoadError" ||
    /Loading chunk \d+ failed/i.test(message) ||
    /Loading CSS chunk \d+ failed/i.test(message) ||
    /Failed to fetch dynamically imported module/i.test(message)
  );
}

function tryReload(reason: string): void {
  try {
    const last = Number(sessionStorage.getItem(SESSION_KEY) ?? "0");
    if (Date.now() - last < COOLDOWN_MS) {
      // Already reloaded once recently — don't trap user in a loop.
      console.warn("[chunk-reload] skipped: recent reload still in cooldown.");
      return;
    }
    sessionStorage.setItem(SESSION_KEY, String(Date.now()));
    console.warn(`[chunk-reload] reloading (${reason})`);
    window.location.reload();
  } catch {
    // sessionStorage blocked (incognito with restrictive cookies);
    // fall through to plain reload without the guard.
    window.location.reload();
  }
}

export default function ChunkErrorAutoReload() {
  useEffect(() => {
    function onError(event: ErrorEvent) {
      if (isChunkLoadError(event.error) || isChunkLoadError(event)) {
        tryReload("error event");
      }
    }
    function onRejection(event: PromiseRejectionEvent) {
      if (isChunkLoadError(event.reason)) {
        tryReload("unhandled rejection");
      }
    }
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
