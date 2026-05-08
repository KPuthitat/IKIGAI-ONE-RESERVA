"use client";

// QR scanner powered by html5-qrcode. Lazy-loaded so the ~150KB library
// only downloads on this page. On a successful decode, parses the URL
// for a ref ('R20260500001') and routes the user to /r/<ref>.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { isBookingRef } from "@/lib/booking-ref";

type Status = "idle" | "starting" | "scanning" | "error";

const READER_ID = "ikigai-qr-reader";

export default function ScannerClient({ lang }: { lang: Lang }) {
  const router = useRouter();
  const scannerRef = useRef<unknown>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [err, setErr] = useState<string | null>(null);
  const [manualRef, setManualRef] = useState("");

  useEffect(() => {
    return () => {
      // Stop the camera if the component unmounts mid-scan.
      const s = scannerRef.current as { stop?: () => Promise<void>; clear?: () => void } | null;
      if (s?.stop) s.stop().catch(() => {}).finally(() => s.clear?.());
    };
  }, []);

  async function start(): Promise<void> {
    setStatus("starting");
    setErr(null);
    try {
      // Dynamic import keeps html5-qrcode out of the main bundle.
      const mod = await import("html5-qrcode");
      const Html5Qrcode = mod.Html5Qrcode;
      const scanner = new Html5Qrcode(READER_ID);
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: "environment" },   // prefer rear camera on phones
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decoded: string) => onDecoded(decoded, scanner),
        () => { /* per-frame errors are noisy; ignore */ }
      );
      setStatus("scanning");
    } catch (e) {
      setStatus("error");
      setErr(e instanceof Error ? e.message : t(lang, "scan.err.generic"));
    }
  }

  async function stop(): Promise<void> {
    const s = scannerRef.current as { stop?: () => Promise<void>; clear?: () => void } | null;
    if (s?.stop) {
      await s.stop().catch(() => {});
      s.clear?.();
    }
    scannerRef.current = null;
    setStatus("idle");
  }

  function onDecoded(text: string, scanner: { stop: () => Promise<void>; clear: () => void }): void {
    // The QR encodes a full URL like https://ikigaimedihealth.com/r/R20260500001
    // We accept either a full URL or a bare ref pasted in.
    const ref = extractRef(text);
    if (!ref) {
      // Decoded something but it wasn't one of ours. Stop and surface
      // the raw value so staff can see what they scanned.
      scanner.stop().catch(() => {}).finally(() => scanner.clear());
      scannerRef.current = null;
      setStatus("error");
      setErr(t(lang, "scan.err.unrecognized") + ` (${text.slice(0, 60)})`);
      return;
    }
    scanner.stop().catch(() => {}).finally(() => scanner.clear());
    scannerRef.current = null;
    router.push(`/r/${ref}`);
  }

  function openManual(): void {
    const ref = manualRef.trim();
    if (!ref) return;
    if (!isBookingRef(ref)) {
      setErr(t(lang, "scan.err.unrecognized") + ` (${ref})`);
      return;
    }
    router.push(`/r/${ref}`);
  }

  return (
    <div className="space-y-4">
      {/* Camera viewport — sized via Tailwind so the html5-qrcode injected
          markup fits cleanly. The library renders a <video> + helper UI
          inside the div with id={READER_ID}. */}
      <div className="card !p-0 overflow-hidden">
        <div
          id={READER_ID}
          className="w-full"
          style={{ minHeight: status === "scanning" ? "320px" : "0" }}
        />
        <div className="p-4">
          {status === "idle" && (
            <button type="button" onClick={start}
              className="btn-primary w-full text-base py-3">
              {t(lang, "scan.startBtn")}
            </button>
          )}
          {status === "starting" && (
            <p className="text-sm text-slate-500 text-center">{t(lang, "scan.starting")}</p>
          )}
          {status === "scanning" && (
            <button type="button" onClick={stop}
              className="w-full py-3 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 font-medium">
              {t(lang, "scan.stopBtn")}
            </button>
          )}
          {err && (
            <p className="text-sm text-rose-600 mt-3">✗ {err}</p>
          )}
        </div>
      </div>

      {/* Manual fallback for when the camera doesn't cooperate */}
      <div className="card space-y-2">
        <h2 className="font-semibold text-slate-800 text-sm">
          {t(lang, "scan.manualTitle")}
        </h2>
        <p className="text-xs text-slate-500">
          {t(lang, "scan.manualHint")}
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            className="input flex-1"
            value={manualRef}
            onChange={(e) => setManualRef(e.target.value.toUpperCase().trim())}
            placeholder="R2026050001"
          />
          <button type="button" onClick={openManual}
            disabled={!manualRef.trim()}
            className="btn-primary text-sm shrink-0 disabled:opacity-50">
            {t(lang, "scan.openBtn")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Extract a booking ref from either a raw ref string or a URL whose
 *  last path segment is a ref. Returns null if no ref recognised. */
function extractRef(text: string): string | null {
  const trimmed = text.trim();
  if (isBookingRef(trimmed.toUpperCase())) return trimmed.toUpperCase();
  // Try to parse as URL and pull the final path segment
  try {
    const u = new URL(trimmed);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
    const candidate = decodeURIComponent(last).toUpperCase();
    if (isBookingRef(candidate)) return candidate;
  } catch {
    // not a URL, ignore
  }
  return null;
}
