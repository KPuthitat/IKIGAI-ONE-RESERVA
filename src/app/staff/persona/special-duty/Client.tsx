"use client";

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/url";

type Slot = { date: string; state: "free" | "full" | "mine" };
type Position = { id: number; slotNo: number; name: string; description: string | null; dailyRate: number; eligible: boolean; days: Slot[] };
type Mine = { id: number; positionName: string; date: string; status: string; amount: number; iDoIt: boolean; reviewNote: string | null; evidenceCount: number };
type Data = {
  status: string;
  slots: { status: string; bookingCloseDate: string | null; minDays: number; positions: Position[] } | null;
  mine: Mine[];
  schedule: Array<{ positionName: string; date: string; name: string }> | null;
};

const MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const DOW = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const fmtDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y + 543}`; };
const fmtShort = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}ที่ ${d}`; };
const money = (n: number) => n.toLocaleString("th-TH");
const DUTY_STATUS: Record<string, string> = {
  booked: "รอปฏิบัติงาน", assigned: "รอปฏิบัติงาน", covered: "ท่านเป็นผู้แทน รอปฏิบัติงาน", submitted: "ส่งหลักฐานแล้ว รอผู้จัดการตรวจ",
  approved: "ตรวจรับแล้ว", absent: "บันทึกว่าขาดปฏิบัติงาน"
};
const todayBkk = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

function downscaleToDataUrl(file: File, maxEdge = 1280, quality = 0.7): Promise<string | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith("image/")) return resolve(null);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d"); if (!ctx) return resolve(null);
      ctx.drawImage(img, 0, 0, w, h); resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

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
    for (const p of (j as Data).slots?.positions ?? []) init[p.id] = p.days.filter((d) => d.state === "mine").map((d) => d.date);
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
  const open = data.slots?.status === "booking_open";

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-ink">ตำแหน่งงานค่าตอบแทนพิเศษ</h1>
        <p className="text-sm text-slate-500">{title}{data.slots?.bookingCloseDate ? ` · ปิดรับการเลือกวันที่ ${fmtDate(data.slots.bookingCloseDate)}` : ""}</p>
      </div>
      {data.slots != null && <div className="card text-sm text-slate-600 space-y-1">
        <p className="font-semibold text-slate-800">วิธีเลือกวัน</p>
        <p>เลือกได้เฉพาะวันที่ท่านมีตารางทำงานปกติ และต้องเลือกให้ครบจำนวนวันขั้นต่ำของแต่ละตำแหน่ง</p>
        <p>วันที่มีผู้เลือกแล้วจะแสดงว่า “เต็ม” โดยไม่แสดงชื่อผู้ที่เลือก</p>
        <p>ค่าตอบแทนจะจ่ายพร้อมค่าบริการในวันที่ 20 ของเดือนถัดไป</p>
      </div>}
      {msg && <div className={`card text-sm whitespace-pre-line ${msg.ok ? "!border-emerald-200 !bg-emerald-50 text-emerald-800" : "!border-red-200 !bg-red-50 text-red-700"}`}>{msg.text}</div>}
      {(data.slots?.positions ?? []).filter((p) => p.eligible).map((p) => {
        const sel = new Set(picked[p.id] ?? []);
        const min = data.slots!.minDays;
        return (
          <section key={p.id} className="card space-y-3">
            <div>
              <h2 className="font-bold text-ink">{p.name}</h2>
              {p.description && <p className="text-sm text-slate-500">{p.description}</p>}
              <p className="text-sm text-slate-600">ค่าตอบแทนวันละ {money(p.dailyRate)} บาท</p>
            </div>
            {p.days.length === 0 ? <p className="text-sm text-slate-500">ท่านไม่มีวันทำงานที่เลือกได้ในเดือนนี้</p> : (
              <>
                <div className={`rounded-xl px-3 py-2 text-sm font-semibold ${sel.size === 0 ? "bg-[var(--surface-field)] text-slate-600" : sel.size < min ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-800"}`}>
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
      {data.mine.length > 0 && <MyDuties mine={data.mine} published={data.slots == null} onChanged={load} setMsg={setMsg} />}
      {data.schedule && <Swaps month={month} setMsg={setMsg} />}
      {data.schedule && <Schedule rows={data.schedule} />}
    </div>
  );
}

function MyDuties({ mine, published, onChanged, setMsg }: { mine: Mine[]; published: boolean; onChanged: () => void; setMsg: (m: { ok: boolean; text: string }) => void }) {
  const [openId, setOpenId] = useState<number | null>(null);
  const [photos, setPhotos] = useState<string[]>([]);
  const [noPeople, setNoPeople] = useState(false);
  const [busy, setBusy] = useState(false);
  const today = todayBkk();

  async function addFiles(files: FileList | null) {
    if (!files) return;
    const out: string[] = [];
    for (const f of Array.from(files)) { const u = await downscaleToDataUrl(f); if (u) out.push(u); }
    setPhotos((p) => [...p, ...out].slice(0, 5));
  }
  async function send(id: number) {
    setBusy(true); setMsg({ ok: true, text: "" });
    const r = await fetch(apiUrl("/api/staff/persona/special-duty/evidence"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ day_id: id, photos, no_people: noPeople }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: j.message ?? "ส่งหลักฐานไม่สำเร็จ" }); return; }
    setMsg({ ok: true, text: "ส่งหลักฐานเรียบร้อยแล้ว รอผู้จัดการตรวจรับ" });
    setOpenId(null); setPhotos([]); setNoPeople(false); onChanged();
  }

  return (
    <section className="card space-y-3">
      <h2 className="font-bold text-ink">{published ? "หน้าที่ของท่าน" : "วันที่ท่านเลือกไว้"}</h2>
      {published && (() => { const total = mine.filter((d) => d.status === "approved" && d.iDoIt).reduce((a, d) => a + d.amount, 0); return total > 0 ? <div className="kpi kpi-ok text-sm text-slate-700">ตรวจรับแล้วเดือนนี้ <b>{money(total)} บาท</b> จ่ายพร้อมค่าบริการวันที่ 20 ของเดือนถัดไป (พนักงานที่หักภาษี ณ ที่จ่ายถูกหัก 3%)</div> : null; })()}
      {published && <p className="text-sm text-slate-600">เมื่อทำหน้าที่เสร็จให้ถ่ายภาพพื้นที่ที่รับผิดชอบ โดยไม่ให้มีบุคคลอยู่ในภาพ แล้วกดส่งหลักฐาน ค่าตอบแทนนับเฉพาะวันที่ผู้จัดการตรวจรับแล้ว และท่านต้องมาทำงานปกติในวันนั้นด้วย</p>}
      <ul className="space-y-2">
        {mine.map((d) => {
          const canSend = published && d.iDoIt && ["booked", "assigned", "covered"].includes(d.status) && today >= d.date;
          return (
            <li key={d.id} className="rounded-xl border border-[var(--card-border)] px-3 py-2 text-sm">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-medium text-ink">{fmtDate(d.date)} · {d.positionName}</div>
                  <div className="text-slate-600">{published ? (DUTY_STATUS[d.status] ?? d.status) : ""}{d.iDoIt && published ? ` · ${money(d.amount)} บาท` : ""}{!d.iDoIt && d.status !== "absent" && published ? " · ผู้อื่นปฏิบัติแทน" : ""}</div>
                  {d.reviewNote && d.status !== "approved" && <div className="text-rose-700">ผู้จัดการแจ้งกลับ: {d.reviewNote}</div>}
                </div>
                {canSend && openId !== d.id && <button type="button" className="btn-primary whitespace-nowrap" onClick={() => { setOpenId(d.id); setPhotos([]); setNoPeople(false); }}>ส่งหลักฐาน</button>}
              </div>
              {openId === d.id && (
                <div className="mt-2 space-y-2 rounded-xl bg-[var(--surface-field)] p-3">
                  <label className="block">
                    <span className="text-sm text-slate-700">ภาพพื้นที่ที่ทำความสะอาด (1 ถึง 5 ภาพ)</span>
                    <input type="file" accept="image/*" capture="environment" multiple className="mt-1 block w-full text-sm" onChange={(e) => addFiles(e.target.files)} />
                  </label>
                  {photos.length > 0 && <div className="flex flex-wrap gap-2">{photos.map((u, i) => (
                    <div key={i} className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={u} alt="" className="h-20 w-20 rounded-md object-cover" />
                      <button type="button" className="absolute -right-1 -top-1 rounded-full bg-rose-600 px-1.5 text-xs text-white" onClick={() => setPhotos((p) => p.filter((_, k) => k !== i))}>ลบ</button>
                    </div>))}</div>}
                  <label className="flex items-start gap-2 text-sm text-slate-700">
                    <input type="checkbox" className="mt-1" checked={noPeople} onChange={(e) => setNoPeople(e.target.checked)} />
                    <span>ข้าพเจ้ายืนยันว่าในภาพมีเฉพาะพื้นที่ทำงาน ไม่มีบุคคลปรากฏอยู่</span>
                  </label>
                  <div className="flex gap-2">
                    <button type="button" className="btn-primary" disabled={busy || photos.length === 0 || !noPeople} onClick={() => send(d.id)}>{busy ? "กำลังส่ง" : "ส่งหลักฐาน"}</button>
                    <button type="button" className="btn-secondary" onClick={() => setOpenId(null)}>ปิด</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type SwapView = { id: number; status: string; note: string | null; decisionNote: string | null; fromUserId: number; fromName: string; toUserId: number; toName: string;
  a: { dayId: number; date: string; positionName: string }; b: { dayId: number; date: string; positionName: string } };
type SwapData = { incoming: SwapView[]; sent: SwapView[]; mine: Array<{ dayId: number; date: string; positionName: string }>;
  others: Array<{ dayId: number; date: string; positionName: string; holderName: string }> };
const SWAP_STATUS: Record<string, string> = { pending_peer: "รอคู่สลับตอบรับ", pending_manager: "รอผู้จัดการอนุมัติ", approved: "อนุมัติแล้ว วันเปลี่ยนเรียบร้อย", declined: "คู่สลับปฏิเสธ", rejected: "ผู้จัดการไม่อนุมัติ", cancelled: "ยกเลิกแล้ว" };

function Swaps({ month, setMsg }: { month: string; setMsg: (m: { ok: boolean; text: string }) => void }) {
  const [d, setD] = useState<SwapData | null>(null);
  const [mine, setMine] = useState(""); const [theirs, setTheirs] = useState(""); const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const r = await fetch(apiUrl(`/api/staff/persona/special-duty/swap?month=${month}`), { cache: "no-store" });
    if (r.ok) setD(await r.json());
  }, [month]);
  useEffect(() => { load(); }, [load]);
  async function post(body: Record<string, unknown>, okText: string) {
    setBusy(true);
    const r = await fetch(apiUrl("/api/staff/persona/special-duty/swap"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month, ...body }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: j.message ?? "ทำรายการไม่สำเร็จ" }); return; }
    setMsg({ ok: true, text: okText }); setMine(""); setTheirs(""); setNote(""); load();
  }
  if (!d) return null;
  const open = (x: SwapView) => ["pending_peer", "pending_manager"].includes(x.status);
  const line = (x: SwapView) => `${x.fromName} ให้วันที่ ${fmtDate(x.a.date)} (${x.a.positionName}) แลกกับวันที่ ${fmtDate(x.b.date)} (${x.b.positionName}) ของ ${x.toName}`;
  return (
    <section className="card space-y-3">
      <h2 className="font-bold text-ink">สลับวัน</h2>
      <p className="text-sm text-slate-600">สลับวันกับเพื่อนร่วมงานได้เมื่อทั้งสองฝ่ายตกลงและผู้จัดการอนุมัติ ต้องแจ้งล่วงหน้าอย่างน้อยหนึ่งวันก่อนวันที่ปฏิบัติงานที่เร็วกว่า และต่างฝ่ายต้องมีตารางทำงานในวันที่ได้รับ</p>
      {d.incoming.filter((x) => x.status === "pending_peer").map((x) => (
        <div key={x.id} className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm space-y-2">
          <div className="font-medium text-amber-900">มีคำขอสลับวันถึงท่าน</div>
          <div className="text-slate-700">{line(x)}</div>
          {x.note && <div className="text-slate-600">เหตุผล: {x.note}</div>}
          <div className="flex gap-2">
            <button type="button" className="btn-primary" disabled={busy} onClick={() => post({ action: "accept", swap_id: x.id }, "ตอบรับแล้ว รอผู้จัดการอนุมัติ")}>ตอบรับ</button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => post({ action: "decline", swap_id: x.id }, "ปฏิเสธคำขอแล้ว")}>ปฏิเสธ</button>
          </div>
        </div>
      ))}
      {d.mine.length > 0 && d.others.length > 0 ? (
        <div className="space-y-2">
          <label className="block text-sm">วันของท่านที่ต้องการให้
            <select className="input mt-1 w-full" value={mine} onChange={(e) => setMine(e.target.value)}>
              <option value="">เลือกวัน</option>
              {d.mine.map((x) => <option key={x.dayId} value={x.dayId}>{fmtDate(x.date)} · {x.positionName}</option>)}
            </select>
          </label>
          <label className="block text-sm">วันของเพื่อนที่ต้องการรับแทน
            <select className="input mt-1 w-full" value={theirs} onChange={(e) => setTheirs(e.target.value)}>
              <option value="">เลือกวัน</option>
              {d.others.map((x) => <option key={x.dayId} value={x.dayId}>{fmtDate(x.date)} · {x.positionName} · {x.holderName}</option>)}
            </select>
          </label>
          <input className="input w-full text-sm" maxLength={200} placeholder="เหตุผล (ไม่บังคับ)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="btn-primary w-full" disabled={busy || !mine || !theirs} onClick={() => post({ action: "propose", my_day_id: Number(mine), their_day_id: Number(theirs), note }, "ส่งคำขอสลับวันแล้ว รอคู่สลับตอบรับ")}>ส่งคำขอสลับวัน</button>
        </div>
      ) : <p className="text-sm text-slate-500">ขณะนี้ไม่มีวันที่สลับได้</p>}
      {d.sent.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-medium text-slate-800">คำขอที่ท่านส่ง</div>
          {d.sent.map((x) => (
            <div key={x.id} className="rounded-xl border border-[var(--card-border)] px-3 py-2 text-sm">
              <div className="text-slate-700">{line(x)}</div>
              <div className="flex items-center justify-between gap-2 mt-1">
                <span className={`tag ${x.status === "approved" ? "tag-ok" : x.status === "declined" || x.status === "rejected" ? "tag-bad" : "tag-warn"}`}>{SWAP_STATUS[x.status] ?? x.status}</span>
                {open(x) && <button type="button" className="text-xs text-rose-700 underline" disabled={busy} onClick={() => post({ action: "cancel", swap_id: x.id }, "ยกเลิกคำขอแล้ว")}>ยกเลิกคำขอ</button>}
              </div>
              {x.decisionNote && <div className="text-slate-600">ผู้จัดการแจ้ง: {x.decisionNote}</div>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Schedule({ rows }: { rows: Array<{ positionName: string; date: string; name: string }> }) {
  const byDate = new Map<string, Array<{ positionName: string; name: string }>>();
  for (const r of rows) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
  return (
    <section className="card space-y-2">
      <h2 className="font-bold text-ink">ตารางของสาขา</h2>
      <ul className="divide-y divide-[var(--card-border)] text-sm">
        {[...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, list]) => (
          <li key={date} className="py-1.5">
            <div className="font-medium text-slate-800">{fmtDate(date)}</div>
            {list.map((x, i) => <div key={i} className="text-slate-600">{x.positionName} · {x.name}</div>)}
          </li>
        ))}
      </ul>
    </section>
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
          if (!state) return <div key={date} className="rounded-xl py-2 text-center text-sm text-slate-300">{d}</div>;
          const full = state === "full";
          return (
            <button key={date} type="button" disabled={!open || full} onClick={() => toggle(date)}
              className={`rounded-xl border py-1.5 text-center leading-tight ${on ? "border-accent bg-accent text-white font-semibold" : full ? "border-[var(--card-border)] bg-[var(--surface-field)] text-slate-400" : "border-[var(--card-border)] text-slate-800 hover:bg-[var(--surface-field)]"}`}>
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
