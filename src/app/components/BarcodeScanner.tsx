"use client";

import { useEffect, useRef, useState } from "react";

// Camera barcode / QR scanner modal.
//
// We load the `html5-qrcode` UMD build from a CDN at runtime (same
// pattern as the LIFF SDK) so there is no npm dependency and the deploy
// stays a plain `git pull && npm run build` — and it works on iOS
// Safari + Android Chrome (getUserMedia + canvas decode, not the
// patchy native BarcodeDetector).
//
// Usage: render <BarcodeScanner onResult={fn} onClose={fn} /> when the
// user taps "scan". onResult fires once with the decoded string, then
// the camera stops and the modal closes itself via onClose.

const CDN = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";
const ELEMENT_ID = "inventa-scanner-view";

type Html5QrcodeInstance = {
  start: (
    camera: { facingMode: string } | string,
    config: { fps: number; qrbox?: number | { width: number; height: number } },
    onSuccess: (decodedText: string) => void,
    onError?: (err: string) => void
  ) => Promise<void>;
  stop: () => Promise<void>;
  clear: () => void;
};
type Html5QrcodeCtor = new (elementId: string) => Html5QrcodeInstance;

function getCtor(): Html5QrcodeCtor | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { Html5Qrcode?: Html5QrcodeCtor }).Html5Qrcode;
}

function ensureScript(): void {
  if (typeof document === "undefined") return;
  if (document.querySelector(`script[data-h5q]`)) return;
  const s = document.createElement("script");
  s.src = CDN;
  s.async = true;
  s.setAttribute("data-h5q", "1");
  document.head.appendChild(s);
}

export default function BarcodeScanner({
  onResult,
  onClose,
  title = "สแกนคิวอาร์โค้ด"
}: {
  onResult: (text: string) => void;
  onClose: () => void;
  title?: string;
}) {
  const [status, setStatus] = useState<"loading" | "scanning" | "error">("loading");
  const [errMsg, setErrMsg] = useState("");
  const instRef = useRef<Html5QrcodeInstance | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    ensureScript();
    let cancelled = false;
    let attempts = 0;

    const stopCam = () => {
      const inst = instRef.current;
      if (inst) {
        inst.stop().then(() => inst.clear()).catch(() => {});
        instRef.current = null;
      }
    };

    const poll = setInterval(async () => {
      if (cancelled) return;
      attempts += 1;
      const Ctor = getCtor();
      if (!Ctor) {
        if (attempts > 40) {           // ~10s
          clearInterval(poll);
          setStatus("error");
          setErrMsg("โหลดตัวสแกนไม่สำเร็จ — ตรวจอินเทอร์เน็ตแล้วลองใหม่ หรือพิมพ์บาร์โค้ดเอง");
        }
        return;
      }
      clearInterval(poll);
      try {
        const inst = new Ctor(ELEMENT_ID);
        instRef.current = inst;
        await inst.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 260, height: 200 } },
          (decodedText) => {
            if (doneRef.current) return;
            doneRef.current = true;
            stopCam();
            onResult(decodedText.trim());
            onClose();
          },
          () => { /* per-frame decode misses — ignore */ }
        );
        if (!cancelled) setStatus("scanning");
      } catch {
        if (cancelled) return;
        setStatus("error");
        setErrMsg("เปิดกล้องไม่สำเร็จ — อนุญาตสิทธิ์กล้อง หรือพิมพ์บาร์โค้ดเอง");
      }
    }, 250);

    return () => {
      cancelled = true;
      clearInterval(poll);
      stopCam();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-sm w-full p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-slate-800 text-base">{title}</h3>

        <div id={ELEMENT_ID}
          className="w-full aspect-square bg-slate-900 rounded-lg overflow-hidden" />

        {status === "loading" && (
          <p className="text-sm text-slate-500 text-center">กำลังเปิดกล้อง...</p>
        )}
        {status === "scanning" && (
          <p className="text-xs text-slate-500 text-center">
            หันกล้องไปที่บาร์โค้ด/QR ของยา — ระบบจะอ่านอัตโนมัติ
          </p>
        )}
        {status === "error" && (
          <p className="text-sm text-rose-600 text-center">{errMsg}</p>
        )}

        <button type="button" onClick={onClose}
          className="w-full py-2.5 rounded-lg bg-slate-100 text-slate-700 text-sm font-medium">
          ปิดกล้อง
        </button>
      </div>
    </div>
  );
}
