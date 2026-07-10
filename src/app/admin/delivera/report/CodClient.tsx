"use client";

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";

type CodItem = { order_id: number; order_no: string; rider_name: string | null; cod_amount: number; delivered_at: string | null };

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso.replace(" ", "T") + "Z");
  return isNaN(d.getTime()) ? iso : d.toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
}

export default function CodClient() {
  const [items, setItems] = useState<CodItem[]>([]);
  const [summary, setSummary] = useState<{ count: number; amount: number }>({ count: 0, amount: 0 });
  const [busy, setBusy] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/admin/delivera/cod"), { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) { setItems(j.items); setSummary(j.summary); }
    } catch { /* ignore */ }
    finally { setLoaded(true); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function settle(orderId: number) {
    setBusy(orderId);
    try {
      const res = await fetch(apiUrl(`/api/admin/delivera/cod/${orderId}`), { method: "POST" });
      if (res.ok) await load();
    } finally { setBusy(null); }
  }

  if (loaded && items.length === 0) {
    return <p className="text-sm text-slate-400">ไม่มีเงินปลายทางค้างส่ง</p>;
  }
  return (
    <div>
      <div className="mb-2 text-sm text-slate-600">
        ค้างรับจากไรเดอร์ <span className="font-bold text-rose-600">฿{fmtMoney(summary.amount)}</span> · {summary.count} บิล
      </div>
      <div className="space-y-1.5">
        {items.map((it) => (
          <div key={it.order_id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
            <div className="min-w-0">
              <div className="text-sm font-mono font-medium text-slate-700">{it.order_no}</div>
              <div className="text-[11px] text-slate-400">{it.rider_name ?? "—"} · ส่ง {fmtWhen(it.delivered_at)}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-sm font-bold text-slate-800">฿{fmtMoney(it.cod_amount)}</span>
              <button type="button" disabled={busy === it.order_id} onClick={() => settle(it.order_id)}
                className="text-[11px] rounded-md bg-emerald-600 text-white px-2.5 py-1 font-medium disabled:opacity-50">รับเงินแล้ว</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
