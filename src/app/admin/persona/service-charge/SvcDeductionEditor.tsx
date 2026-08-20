"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fmtMoney } from "@/lib/format";

// รายการหักอื่นๆ จาก SVC (owner 2026-08-20) — เช่น ค่าเครื่องดื่มที่ไม่ใช่คูปอง.
// แอดมิน (ดู payroll ได้) เพิ่ม/ลบ ต่อคนต่อเดือน · หักหลังค่าอาหาร ก่อนภาษี.
type Item = { id: number; amount: number; reason: string | null };

export default function SvcDeductionEditor({
  userId, yearMonth, displayName, items, canEdit
}: {
  userId: number;
  yearMonth: string;
  displayName: string;
  items: Item[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  const total = items.reduce((s, x) => s + x.amount, 0);

  async function add() {
    const amt = Number(amount);
    if (busy || !amt || amt <= 0) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/admin/persona/service-charge/deduction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, year_month: yearMonth, amount: amt, reason: reason.trim() || undefined })
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? "error");
      setAmount(""); setReason("");
      router.refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : "error"); }
    finally { setBusy(false); }
  }

  async function remove(id: number) {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/admin/persona/service-charge/deduction", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? "error");
      router.refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : "error"); }
    finally { setBusy(false); }
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className={`text-[10px] px-1.5 py-0.5 rounded border font-medium whitespace-nowrap ${
          total > 0 ? "border-rose-300 text-rose-700 bg-rose-50 hover:bg-rose-100" : "border-slate-300 text-slate-600 hover:bg-slate-50"
        }`}>
        {total > 0 ? `หัก −฿${fmtMoney(total)}` : "+ รายการหัก"}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full max-h-[85vh] overflow-y-auto p-4 sm:p-5"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-2 mb-1">
              <h3 className="font-bold text-slate-800 text-sm">รายการหักอื่นๆ จาก SVC — {displayName}</h3>
              <button type="button" onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
            </div>
            <p className="text-[11px] text-slate-500 mb-3">เดือน {yearMonth} · หักหลังค่าอาหาร ก่อนภาษี ณ ที่จ่าย</p>

            {items.length === 0 ? (
              <p className="text-xs text-slate-400 py-2 text-center">ยังไม่มีรายการหัก</p>
            ) : (
              <ul className="space-y-1.5 mb-3">
                {items.map((it) => (
                  <li key={it.id} className="flex items-center justify-between gap-2 text-xs border-b border-slate-100 pb-1.5">
                    <span className="text-slate-700">{it.reason || "ไม่ระบุเหตุผล"}</span>
                    <span className="flex items-center gap-2">
                      <span className="font-semibold text-rose-700">−฿{fmtMoney(it.amount)}</span>
                      {canEdit && (
                        <button type="button" onClick={() => remove(it.id)} disabled={busy}
                          className="text-slate-400 hover:text-rose-600 disabled:opacity-50">✕</button>
                      )}
                    </span>
                  </li>
                ))}
                <li className="flex items-center justify-between gap-2 text-xs font-bold text-slate-800 pt-0.5">
                  <span>รวมหัก</span><span className="text-rose-700">−฿{fmtMoney(total)}</span>
                </li>
              </ul>
            )}

            {canEdit ? (
              <div className="space-y-2 border-t border-slate-100 pt-3">
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="เหตุผล (เช่น ค่าเครื่องดื่ม)"
                  className="input w-full text-sm" maxLength={200} />
                <div className="flex items-center gap-2">
                  <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="จำนวนเงิน"
                    className="input flex-1 text-sm" />
                  <button type="button" onClick={add} disabled={busy || !(Number(amount) > 0)}
                    className="text-xs px-3 py-2 rounded bg-brand text-white font-medium disabled:opacity-50 whitespace-nowrap">
                    {busy ? "…" : "เพิ่มรายการ"}
                  </button>
                </div>
                {err && <div className="text-[11px] text-rose-600">{err === "payout_locked" ? "เดือนนี้ปิดยอด/ทำจ่ายแล้ว แก้ไม่ได้" : `ผิดพลาด (${err})`}</div>}
              </div>
            ) : (
              <p className="text-[11px] text-slate-400 border-t border-slate-100 pt-3">
                ต้องมีสิทธิ์ดู payroll และรอบยังไม่ปิดยอด จึงจะแก้ได้
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
