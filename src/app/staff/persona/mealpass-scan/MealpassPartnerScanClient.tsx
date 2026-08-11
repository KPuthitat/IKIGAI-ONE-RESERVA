"use client";

import { useState } from "react";
import { apiUrl } from "@/lib/url";
import BarcodeScanner from "@/app/components/BarcodeScanner";

type Done = { baht: number; at: string };

const ERR_MSG: Record<string, string> = {
  not_found: "ไม่พบรายการ (รหัสไม่ถูกต้อง)",
  already_confirmed: "รายการนี้ยืนยันไปแล้ว",
  not_pending: "รายการนี้ใช้ไม่ได้แล้ว",
  wrong_partner: "รหัสนี้เป็นของบริษัทอื่น",
  forbidden: "บัญชีนี้ไม่มีสิทธิ์สแกนยืนยัน",
  invalid_body: "รหัสไม่ถูกต้อง",
  cap_exceeded: "พนักงานเกินวงเงินข้ามบริษัทของเดือนนี้แล้ว",
  weekly_cap_exceeded: "พนักงานเกินเพดานหักของสัปดาห์นี้ (ไม่เกิน 20% ของรายได้สัปดาห์)",
};

// Pull an SC-xxxx code out of a scanned QR string (tolerate stray whitespace).
function extractCode(raw: string): string {
  const s = raw.trim().toUpperCase();
  const m = s.match(/\bSC-[A-Z0-9]+/);
  return m ? m[0] : s;
}

export default function MealpassPartnerScanClient() {
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState("");
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [history, setHistory] = useState<Done[]>([]);

  async function confirm(code: string) {
    const c = extractCode(code);
    if (!c) return;
    setBusy(true); setResult(null);
    try {
      const res = await fetch(apiUrl("/api/staff/persona/mealpass/cross-redeem"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: c }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResult({ ok: false, msg: ERR_MSG[j.error as string] ?? "ยืนยันไม่สำเร็จ ลองใหม่อีกครั้ง" });
      } else {
        setResult({ ok: true, msg: `฿${(j.baht as number).toLocaleString()} · หักจากค่าตอบแทนพนักงานแล้ว` });
        setHistory((h) => [{ baht: j.baht, at: new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) }, ...h].slice(0, 20));
        setManual("");
      }
    } catch {
      setResult({ ok: false, msg: "เชื่อมต่อไม่ได้ ลองใหม่อีกครั้ง" });
    }
    setBusy(false);
  }

  return (
    <div className="space-y-4">
      {scanning && (
        <BarcodeScanner
          title="สแกน QR ยืนยันอาหาร (SC)"
          onResult={(text) => { setScanning(false); confirm(text); }}
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

      <button
        onClick={() => { setResult(null); setScanning(true); }}
        disabled={busy}
        className="w-full py-4 rounded-2xl bg-emerald-600 text-white text-lg font-bold active:scale-95 transition disabled:opacity-50"
      >
        {busy ? "กำลังตรวจสอบ…" : "สแกน QR ของพนักงาน"}
      </button>

      <div className="card space-y-2">
        <div className="text-center text-xs text-slate-400">— หรือพิมพ์รหัสเอง (กล้องมีปัญหา) —</div>
        <div className="flex gap-2">
          <input className="input flex-1 font-mono uppercase" value={manual}
            onChange={(e) => setManual(e.target.value.toUpperCase())} placeholder="SC-XXXXXX" />
          <button className="btn-primary" disabled={!manual.trim() || busy} onClick={() => confirm(manual)}>ยืนยัน</button>
        </div>
      </div>

      {history.length > 0 && (
        <div className="card space-y-2">
          <div className="text-sm font-bold text-slate-700">รายการวันนี้ (เครื่องนี้)</div>
          <ul className="divide-y divide-slate-100">
            {history.map((h, i) => (
              <li key={i} className="flex items-center justify-between py-1.5 text-sm">
                <span className="text-slate-500">{h.at}</span>
                <b className="text-slate-800">฿{h.baht.toLocaleString()}</b>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
