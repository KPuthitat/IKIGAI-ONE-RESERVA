"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";

// Order tracking. No Supabase Realtime in this repo → short polling (10s).
// window.liff is typed globally in lib/liff-types.

const STEPS: Array<{ key: string; label: string }> = [
  { key: "paid", label: "รับชำระ/ยืนยัน" },
  { key: "preparing", label: "กำลังทำอาหาร" },
  { key: "ready", label: "พร้อมส่ง" },
  { key: "picked_up", label: "ไรเดอร์รับของ" },
  { key: "delivered", label: "ถึงแล้ว" },
  { key: "completed", label: "เสร็จสิ้น" }
];
const ORDER = ["pending_payment", "paid", "confirmed", "preparing", "ready", "assigned", "picked_up", "delivered", "completed"];

type OrderView = { order_no: string; status: string; fulfillment: string; total: number; pay_status: string; time_slot: string | null };

export default function TrackClient({ liffId, orderNo }: { liffId: string; orderNo: string }) {
  const [token, setToken] = useState("");
  const [order, setOrder] = useState<OrderView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [payMethod, setPayMethod] = useState<"promptpay" | "cod" | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [payBusy, setPayBusy] = useState(false);
  const [payMsg, setPayMsg] = useState<string | null>(null);

  async function choosePay(method: "promptpay" | "cod") {
    setPayBusy(true); setPayMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/delivera/orders/${orderNo}/pay`), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: token, method })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setPayMsg(j.error === "promptpay_not_configured" ? "ร้านยังไม่ได้ตั้งค่า PromptPay" : "ทำรายการไม่สำเร็จ"); return; }
      setPayMethod(method);
      if (method === "promptpay") setQr(j.qr_image ?? null);
      else setPayMsg("ยืนยันออเดอร์แล้ว · ชำระปลายทางกับไรเดอร์");
    } catch { setPayMsg("เชื่อมต่อไม่ได้ ลองใหม่"); }
    finally { setPayBusy(false); }
  }

  // Dark-launch flow: before SlipOK is provisioned, "ฉันโอนแล้ว" queues the order
  // for manual confirmation on the kitchen board. Real slip verification lands
  // with SlipOK + slip upload.
  async function iPaid() {
    setPayBusy(true); setPayMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/delivera/orders/${orderNo}/slip`), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: token, slip_data: "MANUAL_NOTIFY" })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setPayMsg("แจ้งชำระไม่สำเร็จ ลองใหม่"); return; }
      setPayMsg(j.pay_status === "verified" ? "ยืนยันการชำระแล้ว" : "แจ้งชำระแล้ว · รอร้านตรวจสอบสลิป");
    } catch { setPayMsg("เชื่อมต่อไม่ได้ ลองใหม่"); }
    finally { setPayBusy(false); }
  }

  useEffect(() => {
    let stop = false;
    async function boot() {
      if (!liffId) { setErr("ยังไม่ได้ตั้งค่า LIFF"); return; }
      for (let i = 0; i < 100 && !window.liff; i++) await new Promise((r) => setTimeout(r, 50));
      const liff = window.liff;
      if (!liff) { setErr("โหลด LINE SDK ไม่สำเร็จ"); return; }
      await liff.init({ liffId });
      if (!liff.isLoggedIn()) { liff.login(); return; }
      const t = liff.getAccessToken() ?? "";
      setToken(t);
      async function poll() {
        if (stop) return;
        try {
          const res = await fetch(apiUrl(`/api/delivera/orders/${orderNo}?token=${encodeURIComponent(t)}`));
          const j = await res.json();
          if (res.ok && j.ok) setOrder(j.order);
          else if (res.status === 404) setErr("ไม่พบออเดอร์นี้");
        } catch { /* keep polling */ }
        if (!stop) setTimeout(poll, 10000);
      }
      poll();
    }
    boot();
    return () => { stop = true; };
  }, [liffId, orderNo]);

  const currentIdx = order ? ORDER.indexOf(order.status) : -1;

  return (
    <div className="max-w-md mx-auto min-h-screen bg-white px-4 py-6">
      <h1 className="text-lg font-bold text-slate-800">ติดตามออเดอร์</h1>
      <p className="text-sm text-slate-500">เลขที่ {orderNo}</p>
      {err && <p className="text-sm text-rose-600 mt-3">{err}</p>}
      {order?.status === "cancelled" && <p className="text-sm text-rose-600 mt-3">ออเดอร์ถูกยกเลิก</p>}

      {order && order.status === "pending_payment" && order.pay_status !== "verified" && (
        <div className="my-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <div className="text-sm font-bold text-amber-900">ชำระเงิน ฿{fmtMoney(order.total)}</div>
          {!payMethod && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button type="button" disabled={payBusy || !token} onClick={() => choosePay("promptpay")}
                className="rounded-lg bg-brand text-white py-2.5 text-sm font-medium disabled:opacity-50">PromptPay QR</button>
              <button type="button" disabled={payBusy || !token} onClick={() => choosePay("cod")}
                className="rounded-lg border border-slate-300 bg-white text-slate-700 py-2.5 text-sm font-medium disabled:opacity-50">เก็บเงินปลายทาง</button>
            </div>
          )}
          {payMethod === "promptpay" && qr && (
            <div className="mt-3 text-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qr} alt="PromptPay QR" className="mx-auto w-48 h-48" />
              <p className="mt-1 text-[11px] text-slate-500">สแกนจ่ายผ่านแอปธนาคาร แล้วกดปุ่มด้านล่าง</p>
              <button type="button" disabled={payBusy} onClick={iPaid}
                className="mt-2 rounded-lg bg-emerald-600 text-white px-5 py-2 text-sm font-medium disabled:opacity-50">ฉันโอนแล้ว</button>
            </div>
          )}
          {payMsg && <p className="mt-2 text-xs text-emerald-700">{payMsg}</p>}
        </div>
      )}

      {order && order.status !== "cancelled" && (
        <>
          <div className="my-5 space-y-3">
            {STEPS.map((s) => {
              const done = currentIdx >= ORDER.indexOf(s.key);
              return (
                <div key={s.key} className="flex items-center gap-3">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${done ? "bg-brand text-white" : "bg-slate-100 text-slate-400"}`}>
                    {done ? "✓" : "•"}
                  </div>
                  <span className={done ? "text-slate-800 font-medium" : "text-slate-400"}>{s.label}</span>
                </div>
              );
            })}
          </div>
          <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 text-sm space-y-1">
            <div className="flex justify-between text-slate-600"><span>รูปแบบ</span><span>{order.fulfillment === "delivery" ? "จัดส่ง" : "รับเอง"}</span></div>
            <div className="flex justify-between text-slate-600"><span>ชำระเงิน</span><span>{payLabel(order.pay_status)}</span></div>
            {order.time_slot && <div className="flex justify-between text-slate-600"><span>เวลา</span><span>{order.time_slot}</span></div>}
            <div className="flex justify-between font-bold text-slate-800"><span>ยอดรวม</span><span>฿{fmtMoney(order.total)}</span></div>
          </div>
        </>
      )}
      {!order && !err && <p className="text-sm text-slate-400 mt-4">กำลังโหลด…</p>}
    </div>
  );
}

function payLabel(s: string): string {
  return { unpaid: "ยังไม่ชำระ", pending_verify: "รอตรวจสลิป", verified: "ชำระแล้ว", failed: "ล้มเหลว", refunded: "คืนเงิน" }[s] ?? s;
}
