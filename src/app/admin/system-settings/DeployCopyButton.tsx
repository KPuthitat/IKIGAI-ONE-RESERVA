"use client";

import { useState } from "react";

// One-click deploy command (owner 2026-06-24: "ทำเป็นปุ่มให้พร้อมก้อปปี้").
// FORCE=1 skips deploy.sh's window pre-flight so the pasted command runs
// straight through with no y/n prompt. deploy.sh cd's into APP_DIR itself.
const VPS_CMD = "FORCE=1 /var/www/reserva/scripts/deploy.sh";

export default function DeployCopyButton() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(VPS_CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked — the command is visible below to copy manually */ }
  }

  return (
    <div className="card space-y-2">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-bold text-slate-800">Deploy</h2>
          <p className="text-xs text-slate-500">SSH เข้า VPS แล้ววางคำสั่งนี้ — รันทันที ไม่ถามยืนยัน</p>
        </div>
        <button type="button" onClick={copy}
          className="rounded-lg bg-brand text-white px-4 py-2 text-sm font-bold hover:opacity-90 whitespace-nowrap">
          {copied ? "✓ คัดลอกแล้ว" : "📋 คัดลอกคำสั่ง Deploy"}
        </button>
      </div>
      <code className="block bg-slate-900 text-emerald-300 rounded-lg px-3 py-2 text-xs font-mono overflow-x-auto">{VPS_CMD}</code>
      <p className="text-[11px] text-slate-400">FORCE=1 ข้ามการเช็ก deploy window (ไม่มี prompt y/n) · ดู CI ให้เขียวก่อนวาง</p>
    </div>
  );
}
