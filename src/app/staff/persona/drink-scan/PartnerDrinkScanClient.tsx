"use client";

import { useState } from "react";
import { apiUrl } from "@/lib/url";
import BarcodeScanner from "@/app/components/BarcodeScanner";

type Done = { staffName: string; amount: number; at: string };

const ERR_MSG: Record<string, string> = {
  not_found: "ไม่พบรายการ (QR ไม่ถูกต้อง)",
  already: "รายการนี้ถูกสแกนไปแล้ว",
  expired: "QR หมดอายุแล้ว",
  wrong_partner: "QR นี้เป็นของสาขาอื่น",
  forbidden: "บัญชีนี้ไม่มีสิทธิ์สแกนรับเครื่องดื่ม",
  invalid_body: "QR ไม่ถูกต้อง"
};

export default function PartnerDrinkScanClient() {
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [history, setHistory] = useState<Done[]>([]);
  const [tier, setTier] = useState<number | null>(null);

  async function onToken(token: string) {
    setScanning(false);
    if (tier == null) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(apiUrl("/api/staff/persona/drink-redeem"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, amount: tier })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResult({ ok: false, msg: ERR_MSG[j.error as string] ?? "สแกนไม่สำเร็จ ลองใหม่อีกครั้ง" });
      } else {
        setResult({ ok: true, msg: `จ่าย ฿${j.amount} ให้ ${j.staffName} แล้ว` });
        setHistory((h) => [{ staffName: j.staffName, amount: j.amount, at: new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) }, ...h].slice(0, 20));
      }
    } catch {
      setResult({ ok: false, msg: "สแกนไม่สำเร็จ ลองใหม่อีกครั้ง" });
    }
    setBusy(false);
  }

  return (
    <div className="space-y-4">
      {scanning && (
        <BarcodeScanner
          title="สแกน QR เครื่องดื่มของพนักงาน"
          onResult={onToken}
          onClose={() => setScanning(false)}
        />
      )}

      {result && (
        <div className={`card ${result.ok ? "bg-emerald-50 border-emerald-200" : "bg-rose-50 border-rose-200"}`}>
          <div className={`text-base font-bold ${result.ok ? "text-emerald-800" : "text-rose-700"}`}>
            {result.ok ? "✓ สำเร็จ" : "ไม่สำเร็จ"}
          </div>
          <div className="text-sm text-slate-700 mt-1">{result.msg}</div>
        </div>
      )}

      <div className="space-y-2">
        <div className="text-sm font-medium text-slate-700">1. เลือกราคาเครื่องดื่ม</div>
        <div className="grid grid-cols-2 gap-2">
          {[50, 80].map((t) => (
            <button
              key={t}
              onClick={() => setTier(t)}
              className={`py-3 rounded-xl text-base font-bold active:scale-95 transition border-2 ${
                tier === t ? "bg-amber-500 text-white border-amber-500" : "bg-white text-slate-700 border-slate-300"
              }`}
            >
              ฿{t}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={() => { setResult(null); setScanning(true); }}
        disabled={busy || tier == null}
        className="w-full py-4 rounded-2xl bg-emerald-600 text-white text-lg font-bold active:scale-95 transition disabled:opacity-50"
      >
        {busy ? "กำลังตรวจสอบ…" : tier == null ? "เลือกราคาก่อน" : `2. สแกน QR (฿${tier})`}
      </button>

      {history.length > 0 && (
        <div className="card space-y-2">
          <div className="text-sm font-bold text-slate-700">รายการวันนี้ (เครื่องนี้)</div>
          <ul className="divide-y divide-slate-100">
            {history.map((h, i) => (
              <li key={i} className="flex items-center justify-between py-1.5 text-sm">
                <span className="text-slate-700">{h.staffName}</span>
                <span className="text-slate-500">{h.at} · <b className="text-slate-800">฿{h.amount}</b></span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
