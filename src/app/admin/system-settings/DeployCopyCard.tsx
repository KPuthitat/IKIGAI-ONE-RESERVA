"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// One-tap "copy the deploy command" for the owner, who deploys from an SSH
// session. The button is ALWAYS enabled — the live deploy-window status next to
// it is a heads-up (deploy.sh runs the same check and asks y/n), never a lock.
const DEPLOY_CMD = "nokhookos-deploy";
const CHECK_CMD = "curl -s http://ikigaimedihealth.com/api/deploy-window";

type Win = { safe: boolean; warnings: string[]; nextSafeAt: string | null };

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API can be blocked (http, permissions) → legacy fallback.
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }
}

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
}

export default function DeployCopyCard() {
  const [win, setWin] = useState<Win | null>(null);
  const [err, setErr] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/deploy-window", { cache: "no-store" });
      if (!r.ok) throw new Error();
      setWin(await r.json()); setErr(false);
    } catch { setErr(true); }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => { clearInterval(id); if (timer.current) clearTimeout(timer.current); };
  }, [load]);

  async function copy(text: string, key: string) {
    const ok = await copyText(text);
    setCopied(ok ? key : "fail");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 2000);
  }

  const tone = err || !win ? "border-slate-200 bg-slate-50" : win.safe ? "border-emerald-200 bg-emerald-50" : "border-amber-300 bg-amber-50";

  return (
    <div className={`rounded-2xl border p-4 space-y-3 ${tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-bold text-slate-800 text-sm">Deploy</h2>
          <p className="text-xs text-slate-600 mt-0.5">
            กดคัดลอกแล้ววางในเทอร์มินัลบนเซิร์ฟเวอร์ — สคริปต์จะเช็กช่วงเวลาลงเวลางานให้อีกรอบก่อนเริ่ม
          </p>
        </div>
        <button type="button" onClick={() => copy(DEPLOY_CMD, "deploy")}
          className="rounded-xl bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 active:scale-95">
          {copied === "deploy" ? "คัดลอกแล้ว ✓" : copied === "fail" ? "คัดลอกไม่ได้ — เลือกข้อความเอง" : "คัดลอกคำสั่ง deploy"}
        </button>
      </div>

      <code className="block rounded-lg bg-white/80 border border-slate-200 px-3 py-2 text-sm font-mono text-slate-800 select-all">{DEPLOY_CMD}</code>

      <div className="text-xs">
        {err || !win ? (
          <span className="text-slate-500">{err ? "เช็กช่วงเวลา deploy ไม่ได้ตอนนี้ — คัดลอกคำสั่งได้ตามปกติ" : "กำลังเช็กช่วงเวลา deploy…"}</span>
        ) : win.safe ? (
          <span className="font-semibold text-emerald-800">✓ ตอนนี้ deploy ได้ — ไม่มีใครเข้า/ออกงานใกล้ช่วงนี้</span>
        ) : (
          <div className="text-amber-900 space-y-0.5">
            <div className="font-semibold">⚠ ยังไม่ใช่ช่วงที่เหมาะ — มีคนเข้า/ออกงานใกล้ ๆ</div>
            {win.warnings.map((w, i) => <div key={i}>• {w}</div>)}
            {win.nextSafeAt && <div>ช่วงปลอดภัยถัดไป ประมาณ {hhmm(win.nextSafeAt)} น.</div>}
          </div>
        )}
      </div>

      <button type="button" onClick={() => copy(CHECK_CMD, "check")}
        className="text-xs text-slate-500 underline hover:text-slate-700">
        {copied === "check" ? "คัดลอกแล้ว ✓" : "คัดลอกคำสั่งเช็กช่วงเวลา (curl)"}
      </button>
    </div>
  );
}
