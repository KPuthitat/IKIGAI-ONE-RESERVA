"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fmtMoney } from "@/lib/format";

// เบี้ยประชุมเหมาจ่าย (owner 2026-09-20) — ยังไม่ได้นับเวลาเข้าประชุม จึงกรอกยอด
// เหมาจ่ายต่อคนต่อเดือนเอง (ยอดก่อนหักภาษี) แล้วจ่ายพร้อมเซอร์วิสชาร์จเดือนนั้น
// (ขึ้นสลิป/ไฟล์โอน/ลงบัญชี หัก 3% ให้คนที่เป็นหัก ณ ที่จ่าย). หนึ่งยอดต่อคนต่อเดือน.
export default function SvcMeetingFeeEditor({
  userId, yearMonth, displayName, amount, note, canEdit
}: {
  userId: number;
  yearMonth: string;
  displayName: string;
  amount: number;       // current gross amount (0 = none)
  note: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [amt, setAmt] = useState(amount > 0 ? String(amount) : "");
  const [reason, setReason] = useState(note ?? "");
  // Baht may be typed with grouping commas ("1,500"); strip them before parsing.
  const parsedAmt = Number(amt.replace(/,/g, ""));

  // Re-seed the inputs from the current persisted values each time the modal
  // opens, so a refresh elsewhere can't leave stale text behind.
  function openModal() {
    setAmt(amount > 0 ? String(amount) : "");
    setReason(note ?? "");
    setErr(null);
    setOpen(true);
  }

  async function save(next: number) {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/admin/persona/service-charge/meeting-fee", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, year_month: yearMonth, amount: next, note: reason.trim() || undefined })
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? "error");
      setOpen(false);
      router.refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : "error"); }
    finally { setBusy(false); }
  }

  // Hidden entirely for non-editors when there's nothing set (keeps the row clean).
  if (!canEdit && amount <= 0) return null;

  return (
    <>
      <button type="button" onClick={() => canEdit && openModal()} disabled={!canEdit}
        className={`text-[10px] px-1.5 py-0.5 rounded border font-medium whitespace-nowrap ${
          amount > 0 ? "border-violet-300 text-violet-700 bg-violet-50 hover:bg-violet-100" : "border-slate-300 text-slate-600 hover:bg-slate-50"
        } disabled:opacity-100`}
        title={amount > 0 ? `เบี้ยประชุมเหมาจ่าย (ก่อนภาษี) ฿${fmtMoney(amount)}${note ? ` · ${note}` : ""}` : "เพิ่มเบี้ยประชุมเหมาจ่าย"}>
        {amount > 0 ? `เบี้ยประชุม ฿${fmtMoney(amount)}` : "+ เบี้ยประชุม"}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-4 sm:p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-2 mb-1">
              <h3 className="font-bold text-slate-800 text-sm">เบี้ยประชุมเหมาจ่าย — {displayName}</h3>
              <button type="button" onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
            </div>
            <p className="text-[11px] text-slate-500 mb-3">
              เดือน {yearMonth} · กรอกยอด<b>ก่อนหักภาษี</b> · จ่ายพร้อมเซอร์วิสชาร์จเดือนนี้ (หัก 3% ให้คนที่เป็นหัก ณ ที่จ่าย)
            </p>
            <div className="space-y-2">
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="หมายเหตุ (เช่น เหมาจ่าย ส.ค. — ยังไม่ได้นับเวลา)"
                className="input w-full text-sm" maxLength={200} />
              <div className="flex items-center gap-2">
                <input value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" placeholder="ยอดก่อนภาษี (บาท)"
                  className="input flex-1 text-sm" />
                <button type="button" onClick={() => save(parsedAmt || 0)} disabled={busy || !(parsedAmt > 0)}
                  className="text-xs px-3 py-2 rounded bg-brand text-white font-medium disabled:opacity-50 whitespace-nowrap">
                  {busy ? "…" : "บันทึก"}
                </button>
              </div>
              {amount > 0 && (
                <button type="button" onClick={() => save(0)} disabled={busy}
                  className="text-[11px] text-slate-500 hover:text-rose-600 disabled:opacity-50">
                  ลบเบี้ยประชุมเหมาจ่ายของเดือนนี้
                </button>
              )}
              {err && <div className="text-[11px] text-rose-600">{err === "payout_locked" ? "เดือนนี้ปิดยอด/ทำจ่ายแล้ว แก้ไม่ได้" : `ผิดพลาด (${err})`}</div>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
