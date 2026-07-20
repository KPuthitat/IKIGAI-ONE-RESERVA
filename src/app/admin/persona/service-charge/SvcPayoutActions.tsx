"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";
import { formatBkkDateTime } from "@/lib/time";

// "ทำจ่ายแล้ว" — finalize the month's SVC payout and post it to ACCOUNTA
// (owner 2026-07-21). Same accounting as payroll: net SVC = ค่าแรง (จ่ายแล้ว),
// 3% WHT = ภาษีหัก ณ ที่จ่าย (รอจ่าย). PIN-gated on first post + on reversal.
type BatchStatus = "draft" | "posted";

export default function SvcPayoutActions({
  yearMonth, status, totalNet, totalWht, postedAt, netPayoutPreview
}: {
  yearMonth: string;
  status: BatchStatus;
  totalNet: number;
  totalWht: number;
  postedAt: string | null;
  netPayoutPreview: number; // live sum for the not-yet-posted preview
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pinOpen, setPinOpen] = useState<null | "post" | "unpost">(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function call(action: "post" | "unpost" | "repost", withPin?: string) {
    setBusy(true); setError(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/service-charge/payout"), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, yearMonth, pin: withPin })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.message || data.error || "ไม่สำเร็จ"); return; }
      setPinOpen(null); setPin("");
      router.refresh();
    } catch {
      setError("เชื่อมต่อไม่ได้");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-bold text-slate-800 text-sm">การทำจ่ายเซอร์วิสชาร์จ</h2>
          {status === "posted" ? (
            <p className="text-xs text-emerald-700 mt-0.5">
              ✓ ทำจ่ายแล้ว · ลงบัญชี ACCOUNTA แล้ว
              {postedAt ? ` (${formatBkkDateTime(postedAt)})` : ""}
              {" · "}ยอดจ่ายจริง ฿{fmtMoney(totalNet)}
              {totalWht > 0 ? ` · หัก ณ ที่จ่าย ฿${fmtMoney(totalWht)}` : ""}
            </p>
          ) : (
            <p className="text-xs text-slate-500 mt-0.5">
              ยังไม่ได้ทำจ่าย · ยอดจ่ายจริงโดยประมาณ ฿{fmtMoney(netPayoutPreview)}
              {" — "}กด "ทำจ่ายแล้ว" เพื่อบันทึกลงบัญชี
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {status === "posted" ? (
            <>
              <button type="button" disabled={busy} onClick={() => call("repost")}
                className="text-xs px-3 py-1.5 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                ลงบัญชีซ้ำ (อัปเดตยอด)
              </button>
              <button type="button" disabled={busy} onClick={() => { setPinOpen("unpost"); setError(null); }}
                className="text-xs px-3 py-1.5 rounded border border-rose-300 text-rose-600 hover:bg-rose-50 disabled:opacity-50">
                ยกเลิกการจ่าย
              </button>
            </>
          ) : (
            <button type="button" disabled={busy} onClick={() => { setPinOpen("post"); setError(null); }}
              className="text-sm font-bold px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
              ทำจ่ายแล้ว / ลงบัญชี
            </button>
          )}
        </div>
      </div>

      {pinOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !busy && setPinOpen(null)}>
          <div className="bg-white rounded-2xl shadow-xl max-w-xs w-full p-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-slate-800 text-sm mb-1">
              {pinOpen === "post" ? "ยืนยันทำจ่าย + ลงบัญชี" : "ยกเลิกการจ่าย (ลบรายการบัญชี)"}
            </h3>
            <p className="text-[11px] text-slate-500 mb-2">
              {pinOpen === "post"
                ? `บันทึกยอด SVC เดือน ${yearMonth} ลง ACCOUNTA (ค่าแรง + ภาษีหัก ณ ที่จ่าย). ใส่ PIN เพื่อยืนยัน.`
                : `ลบรายการบัญชีของเดือน ${yearMonth} แล้วกลับเป็นยังไม่จ่าย. ใส่ PIN เพื่อยืนยัน.`}
            </p>
            <input type="password" inputMode="numeric" autoFocus value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="PIN"
              className="input w-full text-center tracking-widest mb-2" />
            {error && <p className="text-xs text-rose-600 mb-2">{error}</p>}
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => setPinOpen(null)}
                className="flex-1 text-xs px-3 py-2 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                ยกเลิก
              </button>
              <button type="button" disabled={busy || !pin.trim()}
                onClick={() => call(pinOpen, pin)}
                className={`flex-1 text-xs font-bold px-3 py-2 rounded text-white disabled:opacity-50 ${
                  pinOpen === "post" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-rose-600 hover:bg-rose-700"
                }`}>
                {busy ? "..." : "ยืนยัน"}
              </button>
            </div>
          </div>
        </div>
      )}
      {error && !pinOpen && <p className="text-xs text-rose-600 mt-2">{error}</p>}
    </div>
  );
}
