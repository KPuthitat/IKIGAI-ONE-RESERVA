"use client";

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";

// Live kitchen board + rider dispatch/tracking. No Supabase Realtime → poll 8s.
type OrderRow = {
  id: number; order_no: string; customer_display_name: string | null;
  fulfillment: "delivery" | "pickup"; dest_address: string | null; note: string | null;
  subtotal: number; delivery_fee: number; total: number;
  status: string; pay_method: string | null; pay_status: string;
  time_slot: string | null; created_at: string;
};
type ItemRow = { id: number; name_th: string; qty: number; line_total: number };
type Delivery = { assigned_at: string | null; accepted_at: string | null; picked_up_at: string | null; delivered_at: string | null };
type KOrder = { order: OrderRow; items: ItemRow[]; rider: { id: number; name: string; phone: string | null } | null; delivery: Delivery | null };
type NearRider = { id: number; name: string; vehicle: string | null; plate: string | null; distance_km: number | null; last_seen: string | null };

const PAY_LABEL: Record<string, string> = {
  unpaid: "ยังไม่ชำระ", pending_verify: "รอตรวจสลิป", verified: "ชำระแล้ว", failed: "ล้มเหลว", refunded: "คืนเงิน"
};
const COLS: Array<{ key: string; label: string; statuses: string[] }> = [
  { key: "new", label: "ใหม่ / รอชำระ", statuses: ["pending_payment"] },
  { key: "cooking", label: "กำลังทำ", statuses: ["paid", "confirmed", "preparing"] },
  { key: "ready", label: "พร้อมส่ง / กำลังส่ง", statuses: ["ready", "assigned", "picked_up", "delivered"] }
];

function fmtTime(iso: string): string {
  const d = new Date(iso.replace(" ", "T") + "Z");
  return isNaN(d.getTime()) ? iso : d.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
}
function riderStep(d: Delivery | null): string {
  if (!d) return "";
  if (d.delivered_at) return "ส่งถึงแล้ว";
  if (d.picked_up_at) return "รับของแล้ว · กำลังไปส่ง";
  if (d.accepted_at) return "ไรเดอร์รับงาน";
  if (d.assigned_at) return "รอไรเดอร์รับงาน";
  return "";
}

export default function KitchenClient() {
  const [orders, setOrders] = useState<KOrder[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dispatchFor, setDispatchFor] = useState<number | null>(null);
  const [riders, setRiders] = useState<NearRider[] | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/admin/delivera/kitchen"), { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) { setOrders(j.orders); setErr(null); }
      else if (res.status === 404) setErr("สาขานี้ยังไม่ได้เปิด DELIVERA");
      else if (!res.ok) setErr("โหลดออเดอร์ไม่สำเร็จ");
    } catch { /* keep last data */ }
    finally { setLoaded(true); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);

  async function act(orderId: number, body: Record<string, unknown>) {
    setBusyId(orderId);
    try {
      const res = await fetch(apiUrl(`/api/admin/delivera/kitchen/${orderId}`), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(j.error === "illegal_transition" ? "เปลี่ยนสถานะไม่ได้" : "ทำรายการไม่สำเร็จ"); return; }
      setErr(null); setDispatchFor(null); await load();
    } finally { setBusyId(null); }
  }

  async function openDispatch(orderId: number) {
    setDispatchFor(orderId); setRiders(null);
    try {
      const res = await fetch(apiUrl("/api/admin/delivera/riders"), { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      setRiders(res.ok && j.ok ? j.riders : []);
    } catch { setRiders([]); }
  }

  return (
    <div>
      {err && <p className="text-sm text-rose-600 mb-2">{err}</p>}
      {loaded && orders.length === 0 && !err && <div className="card text-sm text-slate-500">ยังไม่มีออเดอร์ที่กำลังดำเนินการ</div>}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {COLS.map((col) => {
          const list = orders.filter((o) => col.statuses.includes(o.order.status));
          return (
            <div key={col.key} className="rounded-xl bg-slate-50 border border-slate-200 p-2">
              <div className="flex items-center justify-between px-1 py-1.5">
                <h2 className="text-sm font-bold text-slate-700">{col.label}</h2>
                <span className="text-xs text-slate-400">{list.length}</span>
              </div>
              <div className="space-y-2">
                {list.map((o) => (
                  <Card key={o.order.id} o={o} busy={busyId === o.order.id} act={act}
                    dispatchOpen={dispatchFor === o.order.id} riders={riders}
                    onOpenDispatch={() => openDispatch(o.order.id)} onCloseDispatch={() => setDispatchFor(null)} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Card({ o, busy, act, dispatchOpen, riders, onOpenDispatch, onCloseDispatch }: {
  o: KOrder; busy: boolean; act: (id: number, body: Record<string, unknown>) => void;
  dispatchOpen: boolean; riders: NearRider[] | null; onOpenDispatch: () => void; onCloseDispatch: () => void;
}) {
  const { order, items, rider, delivery } = o;
  const paidBadge = order.pay_status === "verified"
    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
    : order.pay_status === "pending_verify"
    ? "bg-amber-50 text-amber-700 border-amber-200"
    : "bg-slate-100 text-slate-500 border-slate-200";
  return (
    <div className="rounded-lg bg-white border border-slate-200 p-2.5 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-mono font-bold text-slate-700">{order.order_no}</span>
        <span className="text-[11px] text-slate-400">{fmtTime(order.created_at)}</span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
        <span className="text-[11px] text-slate-500">{order.fulfillment === "delivery" ? "จัดส่ง" : "รับเอง"}</span>
        <span className={`text-[10px] rounded-full border px-1.5 py-px ${paidBadge}`}>
          {order.pay_method === "cod" ? "ปลายทาง" : PAY_LABEL[order.pay_status] ?? order.pay_status}
        </span>
        {order.time_slot && <span className="text-[10px] text-slate-400">· {order.time_slot}</span>}
      </div>

      <ul className="mt-1.5 space-y-0.5">
        {items.map((it) => (
          <li key={it.id} className="flex justify-between text-xs text-slate-700">
            <span className="truncate pr-2">{it.name_th}</span><span className="shrink-0 text-slate-500">× {it.qty}</span>
          </li>
        ))}
      </ul>

      {order.fulfillment === "delivery" && order.dest_address && (
        <p className="mt-1 text-[11px] text-slate-400 line-clamp-2">ที่อยู่: {order.dest_address}</p>
      )}
      {order.note && <p className="mt-1 text-[11px] text-amber-700">หมายเหตุ: {order.note}</p>}

      {rider && (
        <div className="mt-1.5 rounded-md bg-blue-50 border border-blue-100 px-2 py-1 text-[11px] text-blue-800">
          ไรเดอร์: <span className="font-medium">{rider.name}</span>{rider.phone ? ` · ${rider.phone}` : ""} — {riderStep(delivery)}
        </div>
      )}

      {dispatchOpen && (
        <div className="mt-1.5 rounded-md border border-slate-200 bg-slate-50 p-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-slate-600">ไรเดอร์ที่ว่าง (ใกล้ร้านสุดก่อน)</span>
            <button type="button" onClick={onCloseDispatch} className="text-[11px] text-slate-400 hover:text-slate-600">ปิด</button>
          </div>
          {riders === null && <p className="text-[11px] text-slate-400 mt-1">กำลังค้นหา…</p>}
          {riders?.length === 0 && <p className="text-[11px] text-slate-400 mt-1">ไม่มีไรเดอร์ว่างขณะนี้</p>}
          <div className="mt-1 space-y-1">
            {riders?.map((r) => (
              <button key={r.id} type="button" disabled={busy} onClick={() => act(order.id, { action: "assign", rider_id: r.id })}
                className="w-full flex items-center justify-between rounded bg-white border border-slate-200 px-2 py-1 text-[11px] hover:bg-brand/5 disabled:opacity-50">
                <span className="text-slate-700">{r.name}{r.plate ? ` · ${r.plate}` : ""}</span>
                <span className="text-slate-400">{r.distance_km != null ? `${r.distance_km.toFixed(1)} กม.` : "—"}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-xs font-bold text-slate-800">฿{fmtMoney(order.total)}</span>
        <div className="flex items-center gap-1.5">
          {order.pay_status === "pending_verify" && (
            <button type="button" disabled={busy} onClick={() => act(order.id, { action: "confirm_slip" })}
              className="text-[11px] rounded-md bg-amber-600 text-white px-2 py-1 font-medium disabled:opacity-50">ยืนยันสลิป</button>
          )}
          <PrimaryAction order={order} busy={busy} act={act} onOpenDispatch={onOpenDispatch} />
          {order.status !== "delivered" && order.status !== "picked_up" && (
            <button type="button" disabled={busy} onClick={() => act(order.id, { action: "cancel" })}
              className="text-[11px] text-rose-500 hover:underline disabled:opacity-50">ยกเลิก</button>
          )}
        </div>
      </div>
    </div>
  );
}

function PrimaryAction({ order, busy, act, onOpenDispatch }: {
  order: OrderRow; busy: boolean; act: (id: number, body: Record<string, unknown>) => void; onOpenDispatch: () => void;
}) {
  const btn = (label: string, body: Record<string, unknown>) => (
    <button type="button" disabled={busy} onClick={() => act(order.id, body)}
      className="text-[11px] rounded-md bg-brand text-white px-2.5 py-1 font-medium disabled:opacity-50">{label}</button>
  );
  switch (order.status) {
    case "pending_payment": return btn("รับออเดอร์", { action: "advance", to: "confirmed" });
    case "paid":
    case "confirmed": return btn("เริ่มทำ", { action: "advance", to: "preparing" });
    case "preparing": return btn("ทำเสร็จ", { action: "advance", to: "ready" });
    case "ready":
      if (order.fulfillment === "pickup") return <span className="text-[11px] text-slate-400">รอลูกค้ารับ</span>;
      return (
        <button type="button" disabled={busy} onClick={onOpenDispatch}
          className="text-[11px] rounded-md bg-brand text-white px-2.5 py-1 font-medium disabled:opacity-50">จัดไรเดอร์</button>
      );
    default: return <span className="text-[11px] text-slate-400">กำลังส่ง</span>;
  }
}
