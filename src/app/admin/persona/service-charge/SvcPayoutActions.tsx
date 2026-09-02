"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";
import { formatBkkDateTime } from "@/lib/time";

// 3-step เซอร์วิสชาร์จ payout, mirroring payroll (owner 2026-07-21):
// draft → ปิดยอด(finalize) → ทำจ่าย(paid) → ลงบัญชี(posted). Posting to ACCOUNTA
// happens only at step 3. PIN on finalize / post / unpost.
type Status = "draft" | "finalized" | "paid" | "posted";
type Action = "finalize" | "unfinalize" | "mark_paid" | "unpay" | "post" | "unpost";

export default function SvcPayoutActions({
  yearMonth, status, totalNet, totalWht, postedAt, netPayoutPreview
}: {
  yearMonth: string;
  status: Status;
  totalNet: number;
  totalWht: number;
  postedAt: string | null;
  netPayoutPreview: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pinFor, setPinFor] = useState<null | Action>(null); // which PIN-gated action is confirming
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function call(action: Action, withPin?: string) {
    setBusy(true); setError(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/service-charge/payout"), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, yearMonth, pin: withPin })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.message || data.error || "ไม่สำเร็จ"); return; }
      setPinFor(null); setPin("");
      router.refresh();
    } catch {
      setError("เชื่อมต่อไม่ได้");
    } finally {
      setBusy(false);
    }
  }

  const btnBase = "text-sm px-3 py-1.5 rounded-md disabled:opacity-50";
  const secondary = `${btnBase} bg-white border border-slate-300 text-slate-700 hover:bg-slate-50`;

  return (
    <div className="card">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-bold text-slate-800 text-sm">การทำจ่ายเซอร์วิสชาร์จ</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {status === "draft" && `ยังไม่ปิดยอด · ยอดจ่ายจริงโดยประมาณ ฿${fmtMoney(netPayoutPreview)}`}
            {status === "finalized" && `ปิดยอดแล้ว · รอทำจ่าย · ยอดจ่ายจริงโดยประมาณ ฿${fmtMoney(netPayoutPreview)}`}
            {status === "paid" && `ทำจ่ายแล้ว · รอลงบัญชี · ยอดจ่ายจริงโดยประมาณ ฿${fmtMoney(netPayoutPreview)}`}
            {status === "posted" && (
              <span className="text-emerald-700">
                ✓ ลงบัญชี ACCOUNTA แล้ว{postedAt ? ` (${formatBkkDateTime(postedAt)})` : ""}
                {" · "}ยอดจ่ายจริง ฿{fmtMoney(totalNet)}
                {totalWht > 0 ? ` · หัก ณ ที่จ่าย ฿${fmtMoney(totalWht)}` : ""}
              </span>
            )}
          </p>
          {/* Step indicator */}
          <div className="flex items-center gap-1 mt-1.5 text-[11px]">
            {(["ปิดยอด", "ทำจ่าย", "ลงบัญชี"] as const).map((label, i) => {
              const reached = (status === "finalized" && i === 0)
                || (status === "paid" && i <= 1)
                || (status === "posted" && i <= 2);
              return (
                <span key={label} className="flex items-center gap-1">
                  <span className={`px-2 py-0.5 rounded-full ${reached ? "bg-emerald-100 text-emerald-700 font-semibold" : "bg-slate-100 text-slate-400"}`}>
                    {i + 1}. {label}
                  </span>
                  {i < 2 && <span className="text-slate-300">→</span>}
                </span>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {status === "draft" && (
            <button type="button" disabled={busy} onClick={() => { setPinFor("finalize"); setError(null); }}
              className={`${btnBase} bg-slate-800 hover:bg-slate-900 text-white font-medium`}>
              1. ปิดยอด (finalize)
            </button>
          )}
          {status === "finalized" && (
            <>
              <button type="button" disabled={busy} onClick={() => call("unfinalize")} className={secondary}>
                ↺ ยกเลิกปิดยอด
              </button>
              <button type="button" disabled={busy} onClick={() => call("mark_paid")}
                className={`${btnBase} bg-sky-600 hover:bg-sky-700 text-white font-medium`}>
                2. ทำจ่าย
              </button>
            </>
          )}
          {status === "paid" && (
            <>
              <button type="button" disabled={busy} onClick={() => call("unpay")}
                className={`${btnBase} text-rose-700 hover:bg-rose-50`}>
                ↺ ยกเลิกทำจ่าย
              </button>
              <button type="button" disabled={busy} onClick={() => { setPinFor("post"); setError(null); }}
                className={`${btnBase} bg-emerald-600 hover:bg-emerald-700 text-white font-medium`}>
                3. ลงบัญชี ACCOUNTA
              </button>
            </>
          )}
          {status === "posted" && (
            <>
              <span className="text-sm text-emerald-700 font-medium px-3 py-1.5 rounded-md bg-emerald-50 border border-emerald-200">
                ✓ ลงบัญชีแล้ว
              </span>
              <button type="button" disabled={busy} onClick={() => { setPinFor("unpost"); setError(null); }}
                className={`${btnBase} text-rose-700 hover:bg-rose-50`}>
                ยกเลิกลงบัญชี
              </button>
            </>
          )}
        </div>
      </div>

      {pinFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !busy && setPinFor(null)}>
          <div className="bg-white rounded-2xl shadow-xl max-w-xs w-full p-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-slate-800 text-sm mb-1">
              {pinFor === "finalize" && "ยืนยันปิดยอด"}
              {pinFor === "post" && "ยืนยันลงบัญชี ACCOUNTA"}
              {pinFor === "unpost" && "ยกเลิกลงบัญชี (ลบรายการบัญชี)"}
            </h3>
            <p className="text-[11px] text-slate-500 mb-2">
              {pinFor === "finalize" && `ล็อกยอด เซอร์วิสชาร์จ เดือน ${yearMonth}. ใส่ PIN เพื่อยืนยัน.`}
              {pinFor === "post" && `บันทึกยอด เซอร์วิสชาร์จ เดือน ${yearMonth} ลง ACCOUNTA (ค่าแรง + ภาษีหัก ณ ที่จ่าย). ใส่ PIN.`}
              {pinFor === "unpost" && `ลบรายการบัญชีของเดือน ${yearMonth} แล้วกลับเป็นยังไม่ลงบัญชี. ใส่ PIN.`}
            </p>
            <input type="password" inputMode="numeric" autoFocus value={pin}
              onChange={(e) => setPin(e.target.value)} placeholder="PIN"
              className="input w-full text-center tracking-widest mb-2" />
            {error && <p className="text-xs text-rose-600 mb-2">{error}</p>}
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => setPinFor(null)}
                className="flex-1 text-xs px-3 py-2 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                ยกเลิก
              </button>
              <button type="button" disabled={busy || !pin.trim()} onClick={() => call(pinFor, pin)}
                className={`flex-1 text-xs font-bold px-3 py-2 rounded text-white disabled:opacity-50 ${
                  pinFor === "unpost" ? "bg-rose-600 hover:bg-rose-700" : "bg-emerald-600 hover:bg-emerald-700"
                }`}>
                {busy ? "..." : "ยืนยัน"}
              </button>
            </div>
          </div>
        </div>
      )}
      {error && !pinFor && <p className="text-xs text-rose-600 mt-2">{error}</p>}
    </div>
  );
}
