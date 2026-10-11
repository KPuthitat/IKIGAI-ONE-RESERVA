"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

type Position = { id: number; slotNo: number; name: string; dailyRate: number };
type Row = { id: number; positionId: number; date: string; userId: number; name: string; source: "booked" | "assigned"; status: string; performerName: string | null; reviewNote: string | null; evidenceCount: number; presentAtWork: boolean };
type Open = { positionId: number; positionName: string; date: string; candidates: number };
type Summary = { budget: number; approvedDays: number; approvedAmount: number; pendingDays: number; absentDays: number; unfilledDays: number; heldDays: number };
type Data = { month: { enabled: boolean; status: string; bookingCloseDate: string | null }; positions: Position[]; rows: Row[]; open: Open[]; summary: Summary | null; alerts: Array<{ kind: string; text: string }> };
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
const DAY_STATUS: Record<string, string> = {
  booked: "รอปฏิบัติงาน", assigned: "รอปฏิบัติงาน", covered: "มีผู้แทน รอปฏิบัติงาน", submitted: "ส่งหลักฐานแล้ว รอตรวจ", approved: "ตรวจรับแล้ว", absent: "ขาดปฏิบัติงาน"
};
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
  const [photos, setPhotos] = useState<Array<{ id: number }>>([]);
  const [rejectNote, setRejectNote] = useState("");
  const [subs, setSubs] = useState<Array<{ id: number; name: string }> | null>(null);

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
  const done = async (text: string) => { setMsg({ ok: true, text }); setPlan(null); setPick(null); setSelected(null); setPhotos([]); setRejectNote(""); setSubs(null); await load(); router.refresh(); };
  const open_ = async (row: Row) => {
    setSelected(row); setPick(null); setPhotos([]); setRejectNote(""); setSubs(null);
    if (row.evidenceCount > 0) { const r = await fetch(apiUrl(`/api/admin/persona/special-duty?month=${month}&photos=${row.id}`), { cache: "no-store" }); const j = await r.json(); setPhotos(j.photos ?? []); }
    if (row.status === "absent") { const r = await fetch(apiUrl(`/api/admin/persona/special-duty?month=${month}&substitutes=${row.id}`), { cache: "no-store" }); const j = await r.json(); setSubs(j.candidates ?? []); }
  };

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

          {data.summary && ["special_published", "in_progress", "settled"].includes(st) && (
            <div className="card space-y-2">
              <h2 className="font-semibold text-slate-800">ค่าตอบแทนของเดือนนี้</h2>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-900">ตรวจรับแล้ว {data.summary.approvedDays} วัน<div className="font-bold">{data.summary.approvedAmount.toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท</div></div>
                <div className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900">ยังไม่ตรวจรับ {data.summary.pendingDays} วัน<div className="font-bold">ขาด {data.summary.absentDays} วัน</div></div>
              </div>
              <p className="text-sm text-slate-600">งบสูงสุดของเดือน {data.summary.budget.toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท (ทุกวัน ทุกตำแหน่ง) · วันที่ไม่มีผู้ปฏิบัติ {data.summary.unfilledDays} วัน</p>
              <p className="text-xs text-slate-500">จ่ายเฉพาะวันที่ตรวจรับแล้ว พร้อมค่าบริการวันที่ 20 ของเดือนถัดไป พนักงานที่หักภาษี ณ ที่จ่ายถูกหัก 3% พนักงานในประกันสังคมไม่ถูกหัก</p>
              {data.alerts.length > 0 && <ul className="text-sm text-rose-700 list-disc pl-5">{data.alerts.map((a, i) => <li key={i}>{a.text}</li>)}</ul>}
            </div>
          )}

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
              <p className="text-sm text-slate-600">{fmtDate(selected.date)} · {selected.source === "booked" ? "เลือกเอง" : "ผู้จัดการมอบหมาย"} · {DAY_STATUS[selected.status] ?? selected.status}</p>
              {selected.performerName && <p className="text-sm text-violet-800">ผู้ปฏิบัติแทน: {selected.performerName}</p>}
              {selected.reviewNote && <p className="text-sm text-rose-700">หมายเหตุ: {selected.reviewNote}</p>}
              {["submitted", "approved"].includes(selected.status) && (
                <p className={`text-sm ${selected.presentAtWork ? "text-emerald-700" : "text-rose-700"}`}>
                  {selected.presentAtWork ? "ตรวจพบการลงเวลาเข้างานปกติของผู้ปฏิบัติงานในวันนั้น" : "ไม่พบการลงเวลาเข้างานปกติของผู้ปฏิบัติงานในวันนั้น ตรวจรับไม่ได้"}
                </p>
              )}
              {photos.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {photos.map((ph) => (
                    <a key={ph.id} href={apiUrl(`/api/special-duty/photo/${ph.id}`)} target="_blank" rel="noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={apiUrl(`/api/special-duty/photo/${ph.id}`)} alt="หลักฐาน" className="h-28 w-28 rounded-md object-cover border border-slate-200" />
                    </a>
                  ))}
                </div>
              )}
              {selected.status === "submitted" && (
                <div className="space-y-2">
                  <input className="w-full border border-slate-300 rounded-lg px-3 py-2" placeholder="เหตุผล (ต้องกรอกเมื่อส่งกลับ)" value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} />
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="btn-primary" disabled={busy || !selected.presentAtWork} onClick={async () => { const r = await act({ action: "approve", day_id: selected.id }); r.ok ? done("ตรวจรับเรียบร้อยแล้ว") : setMsg({ ok: false, text: r.j.message ?? "ตรวจรับไม่สำเร็จ" }); }}>ตรวจรับ</button>
                    <button type="button" className="btn-secondary" disabled={busy || rejectNote.trim().length < 3} onClick={async () => { const r = await act({ action: "reject", day_id: selected.id, note: rejectNote }); r.ok ? done("ส่งกลับให้แก้ไขแล้ว") : setMsg({ ok: false, text: r.j.message ?? "ทำรายการไม่สำเร็จ" }); }}>ส่งกลับให้แก้ไข</button>
                  </div>
                </div>
              )}
              {selected.status === "absent" && (
                <div className="space-y-2">
                  <p className="text-sm text-slate-600">เลือกผู้ปฏิบัติแทน (ต้องมีตารางทำงานในวันนั้น ไม่ลา และอยู่ในกลุ่มงานที่กำหนด)</p>
                  {subs == null ? <p className="text-sm text-slate-500">กำลังโหลด</p> : subs.length === 0 ? <p className="text-sm text-rose-700">ไม่มีผู้ที่แทนได้ในวันนี้</p> : (
                    <div className="flex flex-wrap gap-2">
                      {subs.map((u) => <button key={u.id} type="button" className="btn-secondary" disabled={busy} onClick={async () => { const r = await act({ action: "substitute", day_id: selected.id, user_id: u.id }); r.ok ? done("มอบหมายผู้ปฏิบัติแทนแล้ว") : setMsg({ ok: false, text: r.j.message ?? "ทำรายการไม่สำเร็จ" }); }}>{u.name}</button>)}
                    </div>
                  )}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {["booked", "assigned", "submitted", "covered"].includes(selected.status) && ["special_published", "in_progress"].includes(st) && selected.date <= new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10) && (
                  <button type="button" className="btn-secondary" disabled={busy} onClick={async () => { if (!window.confirm("บันทึกว่าผู้ปฏิบัติงานขาดในวันนี้ใช่หรือไม่ รายการนี้นับเป็นการขาดหนึ่งครั้งของผู้ที่ได้รับมอบหมาย")) return; const r = await act({ action: "absent", day_id: selected.id }); r.ok ? done("บันทึกการขาดแล้ว เลือกผู้ปฏิบัติแทนได้ที่ช่องวันนี้") : setMsg({ ok: false, text: r.j.message ?? "ทำรายการไม่สำเร็จ" }); }}>บันทึกว่าขาด</button>
                )}
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
                          if (row) { await open_(row); return; }
                          const r = await fetch(apiUrl(`/api/admin/persona/special-duty?month=${month}&candidates=${p.id}:${date}`), { cache: "no-store" });
                          const j = await r.json(); setSelected(null);
                          setPick({ positionId: p.id, positionName: p.name, date, list: j.candidates ?? [] });
                        }}
                        className={`rounded-md border px-0.5 py-1 text-center leading-tight min-h-[3.2rem] ${row ? (row.status === "approved" ? "border-emerald-600 bg-emerald-200" : row.status === "submitted" ? "border-amber-500 bg-amber-100" : row.status === "absent" ? "border-rose-600 bg-rose-200" : row.status === "covered" ? "border-violet-400 bg-violet-100" : row.source === "booked" ? "border-emerald-300 bg-emerald-50" : "border-sky-300 bg-sky-50") : isOpen ? "border-rose-300 bg-rose-50" : "border-slate-200 text-slate-300"}`}>
                        <div className="text-xs text-slate-500">{d}</div>
                        <div className="text-[10px] text-slate-800 break-words">{row ? row.name : isOpen ? "ว่าง" : ""}</div>
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-slate-500">สีเขียวอ่อนคือพนักงานเลือกเอง สีฟ้าคือผู้จัดการมอบหมาย สีแดงอ่อนคือวันที่ว่าง สีเหลืองคือรอตรวจหลักฐาน สีเขียวเข้มคือตรวจรับแล้ว สีม่วงคือมีผู้แทน สีแดงเข้มคือขาดปฏิบัติงาน</p>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
