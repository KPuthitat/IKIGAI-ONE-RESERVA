"use client";

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/url";

type Slot = { date: string; state: "free" | "full" | "mine" };
type Position = { id: number; slotNo: number; name: string; description: string | null; dailyRate: number; eligible: boolean; days: Slot[] };
type Data = { slots: { status: string; bookingCloseDate: string | null; minDays: number; positions: Position[] }; mine: Array<{ positionName: string; date: string; amount: number }> };

const MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const DOW = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const fmtDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y + 543}`; };
const fmtShort = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}ที่ ${d}`; };
const money = (n: number) => n.toLocaleString("th-TH");

export default function Client({ month }: { month: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(apiUrl(`/api/staff/persona/special-duty?month=${month}`), { cache: "no-store" });
    const j = await r.json();
    if (!r.ok) { setErr(j.error); return; }
    setData(j);
    const init: Record<number, string[]> = {};
    for (const p of (j as Data).slots.positions) init[p.id] = p.days.filter((d) => d.state === "mine").map((d) => d.date);
    setPicked(init);
  }, [month]);
  useEffect(() => { load(); }, [load]);

  async function save(p: Position) {
    setBusy(p.id); setMsg(null);
    const r = await fetch(apiUrl("/api/staff/persona/special-duty"), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month, position_id: p.id, dates: picked[p.id] ?? [] }) });
    const j = await r.json();
    setBusy(null);
    if (r.ok) { setMsg({ ok: true, text: "บันทึกวันที่เลือกเรียบร้อยแล้ว" }); load(); }
    else setMsg({ ok: false, text: (j.errors ?? []).map((e: { message: string; date?: string }) => (e.date ? `${fmtDate(e.date)}: ` : "") + e.message).join("\n") || "ไม่สามารถบันทึกได้" });
  }

  const [y, m] = month.split("-").map(Number);
  const title = `เดือน${MONTHS[m - 1]} ${y + 543}`;
  if (err) return <div className="card text-sm text-slate-600">{err === "not_published" ? "ขณะนี้ยังไม่อยู่ในช่วงเลือกวัน" : err === "month_off" ? "เดือนนี้ไม่มีตำแหน่งงานค่าตอบแทนพิเศษ" : "ไม่สามารถแสดงข้อมูลได้"}</div>;
  if (!data) return <div className="card text-sm text-slate-500">กำลังโหลด</div>;
  const open = data.slots.status === "booking_open";

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold text-slate-900">ตำแหน่งงานค่าตอบแทนพิเศษ</h1>
        <p className="text-sm text-slate-500">{title}{data.slots.bookingCloseDate ? ` · ปิดรับการเลือกวันที่ ${fmtDate(data.slots.bookingCloseDate)}` : ""}</p>
      </div>
      <div className="card text-sm text-slate-600 space-y-1">
        <p className="font-semibold text-slate-800">วิธีเลือกวัน</p>
        <p>เลือกได้เฉพาะวันที่ท่านมีตารางทำงานปกติ และต้องเลือกให้ครบจำนวนวันขั้นต่ำของแต่ละตำแหน่ง</p>
        <p>วันที่มีผู้เลือกแล้วจะแสดงว่า “เต็ม” โดยไม่แสดงชื่อผู้ที่เลือก</p>
        <p>ค่าตอบแทนจะจ่ายพร้อมค่าบริการในวันที่ 20 ของเดือนถัดไป</p>
      </div>
      {msg && <div className={`card text-sm whitespace-pre-line ${msg.ok ? "text-emerald-700" : "text-rose-700"}`}>{msg.text}</div>}
      {data.slots.positions.filter((p) => p.eligible).map((p) => {
        const sel = new Set(picked[p.id] ?? []);
        const min = data.slots.minDays;
        return (
          <section key={p.id} className="card space-y-3">
            <div>
              <h2 className="font-semibold text-slate-900">{p.name}</h2>
              {p.description && <p className="text-sm text-slate-500">{p.description}</p>}
              <p className="text-sm text-slate-600">ค่าตอบแทนวันละ {money(p.dailyRate)} บาท</p>
            </div>
            {p.days.length === 0 ? <p className="text-sm text-slate-500">ท่านไม่มีวันทำงานที่เลือกได้ในเดือนนี้</p> : (
              <>
                <div className={`rounded-lg px-3 py-2 text-sm ${sel.size === 0 ? "bg-slate-50 text-slate-600" : sel.size < min ? "bg-amber-50 text-amber-900" : "bg-emerald-50 text-emerald-800"}`}>
                  {sel.size === 0 ? `ต้องเลือกอย่างน้อย ${min} วัน` : sel.size < min ? `เลือกแล้ว ${sel.size} วัน ต้องเลือกเพิ่มอีก ${min - sel.size} วัน` : `เลือกแล้ว ${sel.size} วัน ครบตามเกณฑ์ขั้นต่ำ ${min} วัน`}
                </div>
                <MonthGrid month={month} days={p.days} sel={sel} open={open}
                  toggle={(date) => setPicked((s) => { const cur = new Set(s[p.id] ?? []); cur.has(date) ? cur.delete(date) : cur.add(date); return { ...s, [p.id]: [...cur].sort() }; })} />
              </>
            )}
            {open && p.days.length > 0 && (
              <button type="button" className="btn-primary w-full" disabled={busy === p.id} onClick={() => save(p)}>
                {busy === p.id ? "กำลังบันทึก" : "ยืนยันวันที่เลือก"}
              </button>
            )}
          </section>
        );
      })}
      {data.mine.length > 0 && (
        <section className="card">
          <h2 className="font-semibold text-slate-900 mb-2">วันที่ท่านเลือกไว้</h2>
          <ul className="text-sm text-slate-700 space-y-1">
            {data.mine.map((d, i) => <li key={i}>{fmtDate(d.date)} · {d.positionName} · {money(d.amount)} บาท</li>)}
          </ul>
        </section>
      )}
    </div>
  );
}

const HEAD = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];

function MonthGrid({ month, days, sel, open, toggle }: { month: string; days: Slot[]; sel: Set<string>; open: boolean; toggle: (d: string) => void }) {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const byDate = new Map(days.map((d) => [d.date, d.state]));
  const cells: Array<number | null> = [...Array(first).fill(null), ...Array.from({ length: last }, (_, i) => i + 1)];
  return (
    <div>
      <div className="grid grid-cols-7 gap-1 text-center text-xs text-slate-500 mb-1">{HEAD.map((h) => <div key={h}>{h}</div>)}</div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (d == null) return <div key={`b${i}`} />;
          const date = `${month}-${String(d).padStart(2, "0")}`;
          const state = byDate.get(date);
          const on = sel.has(date);
          if (!state) return <div key={date} className="rounded-md py-2 text-center text-sm text-slate-300">{d}</div>;
          const full = state === "full";
          return (
            <button key={date} type="button" disabled={!open || full} onClick={() => toggle(date)}
              className={`rounded-md border py-1.5 text-center leading-tight ${on ? "border-amber-700 bg-amber-600 text-white font-semibold" : full ? "border-slate-200 bg-slate-100 text-slate-400" : "border-slate-300 text-slate-800"}`}>
              <div className="text-sm">{d}</div>
              <div className="text-[10px]">{on ? "เลือก" : full ? "เต็ม" : "ว่าง"}</div>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-slate-500">วันที่ไม่มีกรอบคือวันที่ท่านไม่มีตารางทำงาน จึงเลือกไม่ได้</p>
    </div>
  );
}
