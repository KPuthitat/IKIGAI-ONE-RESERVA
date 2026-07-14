"use client";

import { useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/url";

// Full-screen rotating-QR display for the branch door. Polls the current code
// and re-renders the QR when it changes; a per-second countdown shows freshness.
// qrcode is imported dynamically so it stays out of the main bundle.
export default function ClockQrClient({ branchName }: { branchName: string }) {
  const [code, setCode] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number>(0);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const codeRef = useRef<string | null>(null);

  // Fetch the current code. Called on mount and every time the countdown hits 0.
  async function refresh() {
    try {
      const res = await fetch(apiUrl("/api/persona/clock-code"), { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setErr(j.error === "rotating_qr_disabled" ? "สาขานี้ยังไม่ได้เปิด QR หมุนรหัส" : "โหลดรหัสไม่สำเร็จ");
        return;
      }
      setErr(null);
      setSecondsLeft(j.secondsLeft);
      if (j.code !== codeRef.current) {
        codeRef.current = j.code;
        setCode(j.code);
        const QR = (await import("qrcode")).default;
        const url = await QR.toDataURL(j.code, { width: 520, margin: 1, errorCorrectionLevel: "M" });
        setDataUrl(url);
      }
    } catch {
      setErr("เครือข่ายมีปัญหา");
    }
  }

  useEffect(() => {
    refresh();
    // Poll every 5s as a safety net; the per-second tick below triggers a
    // refresh right when a window rolls over so the QR is never stale.
    const poll = setInterval(refresh, 5000);
    const tick = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) { refresh(); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="text-lg font-semibold text-slate-800">
        สแกนเพื่อลงเวลา · {branchName}
      </div>
      <div className="text-sm text-slate-500">
        เปิดแอป → ลงเวลา → สแกน QR นี้ · รหัสเปลี่ยนทุก 30 วินาที
      </div>

      {err ? (
        <div className="text-rose-600 text-sm py-10">{err}</div>
      ) : dataUrl ? (
        <div className="rounded-2xl bg-white p-4 shadow-card">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={dataUrl} alt="QR ลงเวลา" width={340} height={340} className="w-[min(78vw,340px)] h-auto" />
        </div>
      ) : (
        <div className="text-slate-400 py-10">กำลังโหลด…</div>
      )}

      <div className="flex items-center gap-2 text-slate-500 text-sm">
        <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
        รหัสใหม่ในอีก {secondsLeft} วิ
      </div>
      {code && (
        <div className="font-mono text-2xl tracking-[6px] text-slate-700">{code}</div>
      )}
    </div>
  );
}
