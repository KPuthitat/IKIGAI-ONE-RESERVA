"use client";

import { useState } from "react";
import { apiUrl } from "@/lib/url";
import { thaiDate } from "@/lib/revshare";
import { receiptChannelLabel } from "@/lib/clinica-shared";

type Item = { id: number; billNo: string; billDate: string; payerGroup: string; amount: number; settledDate: string; channel: string };

const baht = (n: number) => `${Math.round(n).toLocaleString("th-TH")} บาท`;

// Already-confirmed late payments, collapsed by default. The date and landing channel
// can still be corrected afterwards (owner 2026-11-08) — ACCOUNTA is re-posted for that bill.
export default function ClinicaConfirmedSettlements({ stamp }: { stamp: string }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [channels, setChannels] = useState<string[]>([]);
  const [edit, setEdit] = useState<Record<number, { date: string; channel: string }>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState("");

  async function load() {
    try {
      const res = await fetch(apiUrl("/api/admin/reporta/clinica-settlements?status=confirmed"), { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) { setItems(j.items as Item[]); setChannels(j.channels as string[]); setEdit({}); }
    } catch { /* keep the card closed */ }
  }
  function toggle() { const next = !open; setOpen(next); if (next) void load(); }

  async function save(it: Item) {
    const e = edit[it.id];
    if (!e || busy != null) return;
    setBusy(it.id); setMsg("");
    try {
      const res = await fetch(apiUrl("/api/admin/reporta/clinica-settlements"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: it.id, action: "edit", settledDate: e.date, channel: e.channel })
      });
      const j = await res.json().catch(() => ({})) as { error?: string; accounta?: { error?: string } };
      if (!res.ok) { setMsg(j.error === "bad_date" ? "วันที่ไม่ถูกต้อง" : j.error === "no_channel" ? "เลือกช่องทางที่เงินเข้า" : "บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง"); return; }
      setMsg(j.accounta?.error ? "บันทึกแล้ว แต่ส่งยอดเข้า ACCOUNTA ไม่สำเร็จ — กด \"ส่งใหม่ทั้งหมด\" ในการ์ดส่งยอดเข้า ACCOUNTA" : "บันทึกแล้ว");
      setItems((prev) => (prev ?? []).map((x) => (x.id === it.id ? { ...x, settledDate: e.date, channel: e.channel } : x)));
      setEdit((prev) => { const n = { ...prev }; delete n[it.id]; return n; });
    } catch { setMsg("เชื่อมต่อไม่ได้ ลองใหม่อีกครั้ง"); }
    finally { setBusy(null); }
  }

  return (
    <div className="card space-y-2" data-stamp={stamp}>
      <button type="button" onClick={toggle} className="w-full flex items-center justify-between text-left">
        <h3 className="font-bold text-slate-800 text-sm">รับชำระลูกหนี้ที่ยืนยันแล้ว · แก้วันที่ย้อนหลังได้</h3>
        <span className="text-xs text-slate-400">{open ? "ซ่อน ▲" : "แสดง ▼"}</span>
      </button>
      {open && (items == null ? <p className="text-xs text-slate-400">กำลังโหลด…</p> : items.length === 0 ? <p className="text-xs text-slate-400">ยังไม่มีรายการ</p> : (
        <div className="divide-y divide-slate-100">
          {items.map((it) => {
            const e = edit[it.id] ?? { date: it.settledDate, channel: it.channel };
            const set = (patch: Partial<{ date: string; channel: string }>) => setEdit((prev) => ({ ...prev, [it.id]: { ...e, ...patch } }));
            const dirty = e.date !== it.settledDate || e.channel !== it.channel;
            const opts = channels.includes(e.channel) ? channels : [e.channel, ...channels].filter(Boolean);
            return (
              <div key={it.id} className="py-2 space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="min-w-0 text-xs text-slate-700">
                    <span className="font-semibold">{it.payerGroup || "(ไม่ระบุ)"}</span>
                    <span className="text-slate-400"> · {it.billNo} · บิลวันที่ {it.billDate ? thaiDate(it.billDate) : "—"}</span>
                  </div>
                  <span className="text-sm font-bold tabular-nums text-slate-900 whitespace-nowrap">{baht(it.amount)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input type="date" value={e.date} onChange={(ev) => set({ date: ev.target.value })} className="rounded-lg border border-slate-200 px-2 py-1 text-xs" />
                  <select value={e.channel} onChange={(ev) => set({ channel: ev.target.value })} className="rounded-lg border border-slate-200 px-2 py-1 text-xs max-w-[220px]">
                    {opts.map((c) => <option key={c} value={c}>{receiptChannelLabel(c)}</option>)}
                  </select>
                  <button type="button" disabled={!dirty || !e.date || busy != null} onClick={() => save(it)}
                    className="rounded-full bg-slate-800 px-3 py-1 text-xs font-semibold text-white disabled:opacity-40">บันทึก</button>
                </div>
              </div>
            );
          })}
        </div>
      ))}
      {msg && <p className="text-xs text-slate-600">{msg}</p>}
    </div>
  );
}
