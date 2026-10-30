"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import QrCode from "@/app/components/QrCode";
import { fmtMoney } from "@/lib/format";
import { apiUrl } from "@/lib/url";

type Order = {
  orderNo: string; queueNo: number | null; tableLabel: string | null; service: "pickup" | "dine_in"; status: string; payStatus: string; payMethod: string | null;
  total: number; branchName: string; items: Array<{ name: string; qty: number; options: string; lineTotal: number }>;
  step: 1 | 2 | 3 | 4; ahead: number; estMinutes: number; codEnabled: boolean; hasPromptPay: boolean;
};
type Pay = { total: number; qrPayload: string | null; qrImageUrl: string | null };

const STEPS = ["สั่งแล้ว", "ชำระแล้ว", "กำลังทำ", "พร้อมรับ"];

// The customer's order page (owner 2026-10-30, after KOI's "订单详情"): a big queue number, the four steps, how many orders are
// ahead, and — until it is paid — the PromptPay QR or the pay-at-counter choice. Polls every few seconds; no login.
export default function TrackerClient({ token }: { token: string }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [pay, setPay] = useState<Pay | null>(null);
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const lastStep = useRef<number>(0);

  const load = useCallback(async () => {
    try {
      const r = await fetch(apiUrl(`/api/o/track/${token}`), { cache: "no-store" });
      if (r.status === 404) { setGone(true); return; }
      const j = await r.json();
      if (!j.ok) return;
      setOrder(j.order); setPay(j.pay ?? null);
      if (j.order.step === 4 && lastStep.current !== 0 && lastStep.current < 4) { try { navigator.vibrate?.([300, 150, 300]); } catch { /* not supported */ } }
      lastStep.current = j.order.step;
    } catch { /* keep the last view */ }
  }, [token]);
  useEffect(() => { void load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [load]);

  async function post(path: "paid" | "counter") {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(apiUrl(`/api/o/track/${token}/${path}`), { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setErr(j.message ?? "ทำรายการไม่สำเร็จ กรุณาลองใหม่");
      await load();
    } finally { setBusy(false); }
  }

  if (gone) return <div className="mx-auto max-w-md px-4 py-16 text-center text-slate-600">ไม่พบออเดอร์นี้ค่ะ</div>;
  if (!order) return <div className="mx-auto max-w-md px-4 py-16 text-center text-slate-400">กำลังโหลด…</div>;
  const cancelled = order.status === "cancelled";
  const awaitingPay = order.status === "pending_payment";
  const ready = order.step === 4 && !cancelled;
  const headline = cancelled ? "ออเดอร์ถูกยกเลิก" : ready ? "พร้อมรับแล้ว!" : order.step === 3 ? "กำลังทำ" : order.step === 2 ? "ร้านรับออเดอร์แล้ว" : order.payStatus === "pending_verify" ? "รอร้านยืนยันการชำระเงิน" : "รอชำระเงิน";

  return (
    <div className="mx-auto max-w-lg min-h-screen bg-[#faf7f2] px-4 py-5 space-y-4">
      <div className={`rounded-3xl p-6 text-center shadow-sm border ${ready ? "bg-emerald-50 border-emerald-200" : cancelled ? "bg-rose-50 border-rose-200" : "bg-white border-slate-100"}`}>
        <div className={`text-lg font-bold ${ready ? "text-emerald-700" : cancelled ? "text-rose-700" : "text-slate-800"}`}>{headline}</div>
        {order.queueNo != null && !cancelled && (<><div className="mt-2 text-6xl font-black tracking-tight text-slate-900 tabular-nums">{String(order.queueNo).padStart(3, "0")}</div><div className="text-sm text-slate-500">เลขคิวของท่าน</div></>)}
        <div className="mt-2 text-sm text-slate-500">{order.branchName}{order.tableLabel ? ` · โต๊ะ ${order.tableLabel}` : " · รับที่ร้าน"}</div>
        {ready && <div className="mt-2 text-sm text-emerald-700">กรุณารับที่เคาน์เตอร์ พร้อมแจ้งเลขคิว</div>}
      </div>

      {!cancelled && (
        <div className="rounded-3xl bg-white border border-slate-100 p-5 shadow-sm">
          <ol className="flex items-start justify-between">
            {STEPS.map((s, i) => {
              const done = order.step > i + 1, now = order.step === i + 1;
              return (
                <li key={s} className="flex-1 flex flex-col items-center text-center gap-1.5 relative">
                  {i > 0 && <span className={`absolute top-3.5 right-1/2 w-full h-0.5 ${order.step >= i + 1 ? "bg-brand" : "bg-slate-200"}`} aria-hidden />}
                  <span className={`relative z-10 h-7 w-7 rounded-full flex items-center justify-center text-xs font-bold ${done || now ? "bg-brand text-white" : "bg-slate-200 text-slate-500"} ${now ? "ring-4 ring-brand/20" : ""}`}>{done ? "✓" : i + 1}</span>
                  <span className={`text-xs ${now ? "text-brand font-semibold" : "text-slate-500"}`}>{s}</span>
                </li>
              );
            })}
          </ol>
          {order.step >= 2 && order.step < 4 && <p className="mt-4 text-center text-sm text-slate-600">มีออเดอร์ก่อนหน้า <b>{order.ahead}</b> · รอประมาณ <b>{order.estMinutes}</b> นาที</p>}
        </div>
      )}

      {awaitingPay && !cancelled && (
        <div className="rounded-3xl bg-white border border-slate-100 p-5 shadow-sm space-y-3">
          {order.payStatus === "pending_verify" ? (
            <p className="text-center text-sm text-slate-600">ร้านกำลังตรวจสอบการชำระเงิน สักครู่เมื่อยืนยันแล้วจะเข้าคิวทำทันที</p>
          ) : (
            <>
              <div className="font-semibold text-slate-800">ชำระเงิน ฿{fmtMoney(order.total)}</div>
              {order.hasPromptPay && pay && (pay.qrPayload || pay.qrImageUrl) && (
                <div className="text-center space-y-2">
                  {pay.qrPayload ? <QrCode value={pay.qrPayload} size={220} /> : /* eslint-disable-next-line @next/next/no-img-element */ <img src={pay.qrImageUrl!} alt="PromptPay QR" className="mx-auto w-56 rounded-xl" />}
                  <p className="text-xs text-slate-500">สแกนด้วยแอปธนาคาร ยอด ฿{fmtMoney(order.total)} แล้วกดปุ่มด้านล่าง</p>
                  <button type="button" disabled={busy} onClick={() => post("paid")} className="w-full rounded-2xl bg-brand text-white font-bold py-3 disabled:opacity-50">ฉันโอนเงินแล้ว</button>
                </div>
              )}
              {order.codEnabled && <button type="button" disabled={busy} onClick={() => post("counter")} className="w-full rounded-2xl border border-slate-300 text-slate-700 font-semibold py-3 disabled:opacity-50">ชำระที่เคาน์เตอร์</button>}
              {!order.hasPromptPay && !order.codEnabled && <p className="text-sm text-slate-500">กรุณาแจ้งพนักงานเพื่อชำระเงิน</p>}
            </>
          )}
          {err && <p className="text-sm text-rose-600">{err}</p>}
        </div>
      )}

      <div className="rounded-3xl bg-white border border-slate-100 p-5 shadow-sm">
        <div className="font-semibold text-slate-800 mb-2">รายการ</div>
        <ul className="divide-y divide-slate-100">
          {order.items.map((i, k) => (
            <li key={k} className="py-2 flex justify-between gap-3"><div className="min-w-0"><div className="text-slate-800">{i.name} <span className="text-slate-400">× {i.qty}</span></div>{i.options && <div className="text-xs text-slate-500">{i.options}</div>}</div><div className="tabular-nums text-slate-700">฿{fmtMoney(i.lineTotal)}</div></li>
          ))}
        </ul>
        <div className="mt-2 pt-2 border-t border-slate-200 flex justify-between font-bold text-slate-800"><span>รวม</span><span>฿{fmtMoney(order.total)}</span></div>
        <div className="mt-3 text-[11px] text-slate-400">เลขที่ออเดอร์ {order.orderNo} · เก็บหน้านี้ไว้เพื่อติดตามสถานะ</div>
      </div>
    </div>
  );
}
