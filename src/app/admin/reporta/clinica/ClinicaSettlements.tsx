"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/url";
import { thaiDate } from "@/lib/revshare";
import { receiptChannelLabel } from "@/lib/clinica-shared";

type Item = {
  id: number; billNo: string; billDate: string; payerGroup: string; amount: number;
  detectedOn: string; settledDate: string; channel: string; suggestedChannel: string;
};

const baht = (n: number) => `${Math.round(n).toLocaleString("th-TH")} บาท`;

// Receivables the last import showed as paid. The HIS back-dates receipts to the
// service day, so the system cannot know when the money arrived — it proposes the
// import day and the channel last used for that payer; a person confirms or edits
// before it counts (owner 2026-10-04). Renders nothing when there is nothing to do.
export default function ClinicaSettlements({ pending, stamp }: { pending: number; stamp: string }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [channels, setChannels] = useState<string[]>([]);
  const [edit, setEdit] = useState<Record<number, { date: string; channel: string }>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState("");

  async function load() {
    try {
      const res = await fetch(apiUrl("/api/admin/reporta/clinica-settlements"), { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) { setItems(j.items as Item[]); setChannels(j.channels as string[]); }
    } catch { /* leave the card hidden */ }
  }
  // `stamp` changes whenever the month data is re-fetched (e.g. after an import), so
  // the list is reloaded even when the pending count happens to stay the same.
  useEffect(() => { if (pending > 0) void load(); else setItems([]); }, [pending, stamp]);

  async function act(it: Item, action: "confirm" | "dismiss") {
    if (busy != null) return;
    setBusy(it.id); setErr("");
    const e = edit[it.id];
    try {
      const res = await fetch(apiUrl("/api/admin/reporta/clinica-settlements"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: it.id, action, settledDate: e?.date ?? it.settledDate, channel: e?.channel ?? (it.channel || it.suggestedChannel) })
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        setErr(j.error === "bad_date" ? "วันที่ไม่ถูกต้อง" : j.error === "no_channel" ? "เลือกช่องทางที่เงินเข้า" : j.error === "not_pending" ? "รายการนี้ถูกจัดการไปแล้ว" : "บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง");
        if (j.error === "not_pending") void load();
        return;
      }
      const ok = await res.json().catch(() => ({})) as { accounta?: { error?: string } };
      if (ok.accounta?.error) setErr("บันทึกแล้ว แต่ส่งยอดเข้า ACCOUNTA ไม่สำเร็จ — กด \"ส่งใหม่ทั้งหมด\" ในการ์ดส่งยอดเข้า ACCOUNTA");
      setItems((prev) => (prev ?? []).filter((x) => x.id !== it.id));
    } catch { setErr("เชื่อมต่อไม่ได้ ลองใหม่อีกครั้ง"); }
    finally { setBusy(null); }
  }

  if (!items || items.length === 0) return null;
  const total = items.reduce((s, x) => s + x.amount, 0);
  return (
    <div className="card space-y-2 border-amber-200 bg-amber-50/30">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-bold text-slate-800 text-sm">ได้รับชำระแล้ว · รอยืนยันวันที่รับเงิน ({items.length} บิล)</h3>
        <span className="text-sm font-bold text-emerald-600">{baht(total)}</span>
      </div>
      <p className="text-[11px] text-slate-500">ระบบเห็นว่าบิลเหล่านี้ไม่ค้างแล้ว วันที่ตั้งต้นคือวันที่นำเข้าไฟล์ — แก้วันที่/ช่องทางให้ตรงกับเงินเข้าจริงก่อนกดยืนยัน</p>
      <div className="divide-y divide-slate-100">
        {items.map((it) => {
          const e = edit[it.id] ?? { date: it.settledDate, channel: it.channel || it.suggestedChannel };
          const set = (patch: Partial<{ date: string; channel: string }>) => setEdit((prev) => ({ ...prev, [it.id]: { ...e, ...patch } }));
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
                <input type="date" value={e.date} onChange={(ev) => set({ date: ev.target.value })}
                  className="rounded-lg border border-slate-200 px-2 py-1 text-xs" />
                <select value={e.channel} onChange={(ev) => set({ channel: ev.target.value })}
                  className="rounded-lg border border-slate-200 px-2 py-1 text-xs max-w-[220px]">
                  {opts.map((c) => <option key={c} value={c}>{receiptChannelLabel(c)}</option>)}
                </select>
                <button type="button" disabled={busy != null || !e.date} onClick={() => act(it, "confirm")}
                  className="rounded-full bg-emerald-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50">ยืนยัน</button>
                <button type="button" disabled={busy != null} onClick={() => act(it, "dismiss")}
                  className="text-xs text-slate-400 hover:text-slate-600">ไม่ใช่การชำระเงิน</button>
              </div>
            </div>
          );
        })}
      </div>
      {err && <p className="text-xs text-rose-600">{err}</p>}
    </div>
  );
}
