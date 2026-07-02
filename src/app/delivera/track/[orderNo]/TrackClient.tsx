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
