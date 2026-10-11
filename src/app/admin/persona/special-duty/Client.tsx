"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

type Position = { id: number; slotNo: number; name: string; dailyRate: number };
type Row = { id: number; positionId: number; date: string; userId: number; name: string; source: "booked" | "assigned"; status: string };
type Open = { positionId: number; positionName: string; date: string; candidates: number };
type Data = { month: { enabled: boolean; status: string; bookingCloseDate: string | null }; positions: Position[]; rows: Row[]; open: Open[] };
type Plan = { suggestions: Array<{ positionName: string; date: string; userName: string }>; unfillable: Open[] };

const MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const STATUS_TH: Record<string, string> = {
  off: "ยังไม่เปิดใช้ในเดือนนี้", awaiting_roster: "รอประกาศตารางงานประจำเดือน", booking_open: "เปิดให้พนักงานเลือกวัน",
  booking_closed: "ปิดรับการเลือกวันแล้ว", filling: "กำลังจัดวันที่ว่าง", special_published: "ประกาศตารางแล้ว",
  in_progress: "อยู่ระหว่างปฏิบัติงาน", settled: "ปิดรอบแล้ว"
};
const fmtDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y + 543}`; };
const shiftMonth = (ym: string, by: number) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7); };
const HEAD = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
const ERR: Record<string, string> = { unfilled_days: "ยังมีวันที่ว่างอยู่", invalid_transition: "ขั้นตอนนี้ทำไม่ได้ในสถานะปัจจุบัน", not_removable: "ถอนไม่ได้ เพราะมีการส่งหลักฐานแล้ว", wrong_stage: "ถอนได้เฉพาะช่วงจัดวันที่ว่าง", not_found: "ไม่พบรายการ" };

export default function Client({ month }: { month: string }) {
  const router = useRouter();
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [pick, setPick] = useState<{ positionId: number; positionName: string; date: string; list: Array<{ id: number; name: string }> } | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(apiUrl(`/api/admin/persona/special-duty?month=${month}`), { cache: "no-store" });
    const j = await r.json();
    if (!r.ok) { setErr(j.error ?? "error"); return; }
    setData(j);
  }, [month]);
  useEffect(() => { load(); }, [load]);

  async function act(body: Record<string, unknown>) {
    setBusy(true); setMsg(null);
    const r = await fetch(apiUrl("/api/admin/persona/special-duty"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ month, ...body }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    return { ok: r.ok, j };
  }
  const done = async (text: string) => { setMsg({ ok: true, text }); setPlan(null); setPick(null); setSelected(null); await load(); router.refresh(); };

  if (err) return <div className="card text-sm text-rose-700">{err === "forbidden" ? "เฉพาะผู้ดูแลสาขาเท่านั้นที่ใช้หน้านี้ได้" : "ไม่สามารถแสดงข้อมูลได้"}</div>;
  if (!data) return <div className="card text-sm text-slate-500">กำลังโหลด</div>;
  const st = data.month.status;
  const [y, m] = month.split("-").map(Number);
  const filling = st === "booking_closed" || st === "filling";
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();

  return (
    <div className="space-y-4 max-w-4xl">
      <div>
        <h1 className="text-xl font-bold text-slate-900">ตำแหน่งงานค่าตอบแทนพิเศษ</h1>
        <p className="text-sm text-slate-500 mt-1">ดูผู้ที่เลือกวัน จัดวันที่ว่าง และประกาศตารางของสาขา</p>
      </div>

      <div className="card flex items-center justify-between gap-2">
        <button type="button" className="btn-secondary !py-1 !px-3 whitespace-nowrap" onClick={() => router.push(`?month=${shiftMonth(month, -1)}`)}>เดือนก่อน</button>
        <div className="text-center">
          <div className="font-semibold text-slate-900">เดือน{MONTHS[m - 1]} {y + 543}</div>
          <div className="text-sm text-amber-800">{STATUS_TH[st] ?? st}{st === "booking_open" && data.month.bookingCloseDate ? ` · ปิดรับวันที่ ${fmtDate(data.month.bookingCloseDate)}` : ""}</div>
        </div>
        <button type="button" className="btn-secondary !py-1 !px-3 whitespace-nowrap" onClick={() => router.push(`?month=${shiftMonth(month, 1)}`)}>เดือนถัดไป</button>
      </div>

      {msg && <div className={`card text-sm ${msg.ok ? "text-emerald-700" : "text-rose-700"}`}>{msg.text}</div>}

      {!data.month.enabled ? <div className="card text-sm text-slate-600">เดือนนี้ยังไม่เปิดใช้ตำแหน่งงานค่าตอบแทนพิเศษ</div> : (
        <>
          <div className="card space-y-2">
            <h2 className="font-semibold text-slate-800">ขั้นตอน</h2>
            {st === "awaiting_roster" && <p className="text-sm text-slate-600">เมื่อประกาศตารางงานประจำเดือน ระบบจะเปิดให้พนักงานเลือกวันและแจ้งผ่าน LINE ให้โดยอัตโนมัติ</p>}
            {st === "booking_open" && (
              <>
                <p className="text-sm text-slate-600">ระบบจะปิดรับการเลือกวันเองเมื่อพ้นวันที่กำหนด หากต้องการปิดก่อนกำหนดกดปุ่มด้านล่าง</p>
                <button type="button" className="btn-secondary" disabled={busy} onClick={async () => { const r = await act({ action: "close_booking" }); r.ok ? done("ปิดรับการเลือกวันแล้ว") : setMsg({ ok: false, text: ERR[r.j.error] ?? "ทำรายการไม่สำเร็จ" }); }}>ปิดรับการเลือกวันก่อนกำหนด</button>
              </>
            )}
            {filling && (
              <>
                <p className="text-sm text-slate-600">มีวันที่ว่างอยู่ {data.open.length} วัน ท่านเลือกให้ระบบแนะนำโดยหมุนเวียนให้เป็นธรรม หรือกดที่ช่องว่างในปฏิทินเพื่อเลือกผู้ปฏิบัติงานเอง</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn-secondary" disabled={busy || data.open.length === 0} onClick={async () => { const r = await act({ action: "suggest" }); r.ok ? setPlan(r.j.plan) : setMsg({ ok: false, text: ERR[r.j.error] ?? "ทำรายการไม่สำเร็จ" }); }}>ให้ระบบแนะนำวันที่ว่าง</button>
                  <button type="button" className="btn-primary" disabled={busy} onClick={async () => {
                    if (data.open.length > 0 && !window.confirm(`ยังมีวันที่ว่าง ${data.open.length} วัน ต้องการประกาศตารางทั้งที่ยังมีวันว่างหรือไม่`)) return;
                    const r = await act({ action: "publish", allow_unfilled: true });
                    r.ok ? done("ประกาศตารางตำแหน่งงานค่าตอบแทนพิเศษแล้ว และแจ้งพนักงานแต่ละคนทาง LINE") : setMsg({ ok: false, text: ERR[r.j.error] ?? "ประกาศไม่สำเร็จ" });
                  }}>ประกาศตาราง</button>
                </div>
              </>
            )}
            {["special_published", "in_progress", "settled"].includes(st) && <p className="text-sm text-slate-600">ประกาศตารางแล้ว พนักงานในสาขาเห็นรายชื่อผู้ปฏิบัติงานแต่ไม่เห็นค่าตอบแทน</p>}
          </div>

          {plan && (
            <div className="card space-y-2 border-amber-300">
              <h2 className="font-semibold text-slate-800">ข้อเสนอของระบบ (ยังไม่บันทึก)</h2>
              <p className="text-sm text-slate-600">แนะนำ {plan.suggestions.length} วัน{plan.unfillable.length ? ` · ไม่มีผู้ที่เลือกได้ ${plan.unfillable.length} วัน` : ""}</p>
              <ul className="text-sm text-slate-700 max-h-64 overflow-y-auto space-y-0.5">
                {plan.suggestions.map((s, i) => <li key={i}>{fmtDate(s.date)} · {s.positionName} · {s.userName}</li>)}
              </ul>
              <div className="flex gap-2">
                <button type="button" className="btn-primary" disabled={busy} onClick={async () => { const r = await act({ action: "apply_suggestions" }); r.ok ? done("บันทึกวันที่แนะนำเรียบร้อยแล้ว") : setMsg({ ok: false, text: ERR[r.j.error] ?? "บันทึกไม่สำเร็จ" }); }}>ใช้ข้อเสนอนี้</button>
                <button type="button" className="btn-secondary" onClick={() => setPlan(null)}>ปิด</button>
              </div>
            </div>
          )}

          {pick && (
            <div className="card space-y-2 border-amber-300">
              <h2 className="font-semibold text-slate-800">เลือกผู้ปฏิบัติงาน</h2>
              <p className="text-sm text-slate-600">{pick.positionName} · {fmtDate(pick.date)}</p>
              {pick.list.length === 0 ? <p className="text-sm text-rose-700">ไม่มีพนักงานที่เลือกได้ในวันนี้ (ต้องมีตารางทำงาน ไม่ลา และอยู่ในกลุ่มงานที่กำหนด)</p> : (
                <div className="flex flex-wrap gap-2">
                  {pick.list.map((u) => (
                    <button key={u.id} type="button" className="btn-secondary" disabled={busy} onClick={async () => {
                      const r = await act({ action: "assign", position_id: pick.positionId, date: pick.date, user_id: u.id });
                      r.ok ? done("มอบหมายเรียบร้อยแล้ว") : setMsg({ ok: false, text: (r.j.errors ?? []).map((e: { message: string }) => e.message).join("\n") || "มอบหมายไม่สำเร็จ" });
                    }}>{u.name}</button>
                  ))}
                </div>
              )}
              <button type="button" className="btn-secondary" onClick={() => setPick(null)}>ปิด</button>
            </div>
          )}

          {selected && (
            <div className="card space-y-2 border-amber-300">
              <h2 className="font-semibold text-slate-800">{selected.name}</h2>
              <p className="text-sm text-slate-600">{fmtDate(selected.date)} · {selected.source === "booked" ? "เลือกเอง" : "ผู้จัดการมอบหมาย"}</p>
              <div className="flex gap-2">
                {filling && <button type="button" className="btn-secondary" disabled={busy} onClick={async () => { const r = await act({ action: "remove", day_id: selected.id }); r.ok ? done("ถอนวันนี้ออกแล้ว") : setMsg({ ok: false, text: ERR[r.j.error] ?? "ถอนไม่สำเร็จ" }); }}>ถอนออก</button>}
                <button type="button" className="btn-secondary" onClick={() => setSelected(null)}>ปิด</button>
              </div>
            </div>
          )}

          {data.positions.map((p) => {
            const byDate = new Map(data.rows.filter((r) => r.positionId === p.id).map((r) => [r.date, r]));
            const openSet = new Set(data.open.filter((o) => o.positionId === p.id).map((o) => o.date));
            const cells: Array<number | null> = [...Array(first).fill(null), ...Array.from({ length: last }, (_, i) => i + 1)];
            return (
              <section key={p.id} className="card space-y-2">
                <h2 className="font-semibold text-slate-900">{p.name}</h2>
                <div className="grid grid-cols-7 gap-1 text-center text-xs text-slate-500">{HEAD.map((h) => <div key={h}>{h}</div>)}</div>
                <div className="grid grid-cols-7 gap-1">
                  {cells.map((d, i) => {
                    if (d == null) return <div key={`b${i}`} />;
                    const date = `${month}-${String(d).padStart(2, "0")}`;
                    const row = byDate.get(date);
                    const isOpen = openSet.has(date);
                    return (
                      <button key={date} type="button" disabled={!row && !(filling && isOpen)}
                        onClick={async () => {
                          if (row) { setSelected(row); setPick(null); return; }
                          const r = await fetch(apiUrl(`/api/admin/persona/special-duty?month=${month}&candidates=${p.id}:${date}`), { cache: "no-store" });
                          const j = await r.json(); setSelected(null);
                          setPick({ positionId: p.id, positionName: p.name, date, list: j.candidates ?? [] });
                        }}
                        className={`rounded-md border px-0.5 py-1 text-center leading-tight min-h-[3.2rem] ${row ? (row.source === "booked" ? "border-emerald-300 bg-emerald-50" : "border-sky-300 bg-sky-50") : isOpen ? "border-rose-300 bg-rose-50" : "border-slate-200 text-slate-300"}`}>
                        <div className="text-xs text-slate-500">{d}</div>
                        <div className="text-[10px] text-slate-800 break-words">{row ? row.name : isOpen ? "ว่าง" : ""}</div>
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-slate-500">สีเขียวคือพนักงานเลือกเอง สีฟ้าคือผู้จัดการมอบหมาย สีแดงคือวันที่ว่าง</p>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
