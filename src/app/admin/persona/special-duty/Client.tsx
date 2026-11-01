"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import EmptyState from "@/app/components/EmptyState";

type Position = { id: number; slotNo: number; name: string; dailyRate: number };
type Row = { id: number; positionId: number; date: string; userId: number; name: string; source: "booked" | "assigned"; status: string; performerName: string | null; reviewNote: string | null; evidenceCount: number; presentAtWork: boolean; replacement: { fromName: string; toName: string; reasonText: string; at: string } | null };
type Open = { positionId: number; positionName: string; date: string; candidates: number };
type Summary = { budget: number; approvedDays: number; approvedAmount: number; pendingDays: number; absentDays: number; unfilledDays: number; heldDays: number };
type Data = { month: { enabled: boolean; status: string; bookingCloseDate: string | null }; positions: Position[]; rows: Row[]; open: Open[]; changes: Array<{ id: number; dayId: number; date: string; positionName: string; requesterName: string; proposedId: number | null; proposedName: string | null; reasonText: string }>; swaps: Array<{ id: number; note: string | null; fromName: string; toName: string; a: { date: string; positionName: string }; b: { date: string; positionName: string } }>; summary: Summary | null; alerts: Array<{ kind: string; text: string }> };
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
const ERR: Record<string, string> = { invalid_date: "วันปิดรับไม่ถูกต้อง (ต้องไม่เป็นวันที่ผ่านมาแล้ว และอยู่ภายในเดือนนั้น)", unfilled_days: "ยังมีวันที่ว่างอยู่", invalid_transition: "ขั้นตอนนี้ทำไม่ได้ในสถานะปัจจุบัน", not_removable: "ถอนไม่ได้ เพราะมีการส่งหลักฐานแล้ว", wrong_stage: "ถอนได้ก่อนประกาศตารางเท่านั้น", not_found: "ไม่พบรายการ" };

// A dialog opened right where the manager is working, so reviewing a day never means scrolling back up the page
// (owner 2026-10-29: เวลากดจะเช็กงาน มันไกลกันเกิน). Click outside or ปิด to dismiss.
function Sheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" className="bg-white w-full sm:max-w-2xl max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl shadow-2xl p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

export default function Client({ month }: { month: string }) {
  const router = useRouter();
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [pick, setPick] = useState<{ positionId: number; positionName: string; date: string; list: Array<{ id: number; name: string }>; others: Array<{ id: number; name: string; reasons: string[]; overridable: boolean }> } | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);
  const [photos, setPhotos] = useState<Array<{ id: number }>>([]);
  // duplicate-photo warnings for the opened day (owner 2026-10-29: ช่วยตรวจจับการส่งภาพซ้ำ)
  type DupFlag = { kind: "identical" | "similar" | "older_photo"; photoId: number; takenAt?: string; other?: { dayId: number; date: string; positionName: string; performerName: string; status: string; branchName: string } };
  const [flags, setFlags] = useState<DupFlag[]>([]);
  const [rejectNote, setRejectNote] = useState("");
  const [subs, setSubs] = useState<Array<{ id: number; name: string }> | null>(null);
  // changing who does a day, with the reason (owner 2026-11-01)
  const [replacing, setReplacing] = useState(false);
  const [repReason, setRepReason] = useState<"sick" | "personal" | "emergency" | "other" | "">("");
  const [repNote, setRepNote] = useState("");
  // who did not (or will not) get the booking card, with the reason (owner 2026-10-20)
  const [missed, setMissed] = useState<{ list: Array<{ userId: number; name: string; reasonText: string }>; sentNote: string | null } | null>(null);
  const [closeDate, setCloseDate] = useState("");   // this branch's own closing day (booking stage)

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
  const done = async (text: string) => { setMsg({ ok: true, text }); setCloseDate(""); setPlan(null); setPick(null); setSelected(null); setPhotos([]); setFlags([]); setRejectNote(""); setSubs(null); setReplacing(false); setRepReason(""); setRepNote(""); await load(); router.refresh(); };
  const open_ = async (row: Row) => {
    setSelected(row); setPick(null); setPhotos([]); setFlags([]); setRejectNote(""); setSubs(null); setReplacing(false); setRepReason(""); setRepNote("");
    if (row.evidenceCount > 0) { const r = await fetch(apiUrl(`/api/admin/persona/special-duty?month=${month}&photos=${row.id}`), { cache: "no-store" }); const j = await r.json(); setPhotos(j.photos ?? []); setFlags(j.flags ?? []); }
    if (row.status === "absent") { const r = await fetch(apiUrl(`/api/admin/persona/special-duty?month=${month}&substitutes=${row.id}`), { cache: "no-store" }); const j = await r.json(); setSubs(j.candidates ?? []); }
  };

  const startReplace = async (row: Row) => {
    setReplacing(true); setSubs(null);
    const r = await fetch(apiUrl(`/api/admin/persona/special-duty?month=${month}&substitutes=${row.id}`), { cache: "no-store" }); const j = await r.json(); setSubs(j.candidates ?? []);
  };

  if (err) return <div className="card tag-bad text-sm">{err === "forbidden" ? "เฉพาะผู้ดูแลสาขาเท่านั้นที่ใช้หน้านี้ได้" : "ไม่สามารถแสดงข้อมูลได้"}</div>;
  if (!data) return <div className="card text-sm text-slate-500">กำลังโหลด...</div>;
  const st = data.month.status;
  const [y, m] = month.split("-").map(Number);
  const filling = st === "booking_closed" || st === "filling";
  const canEdit = st === "booking_open" || filling;   // the back office may add or free days until the schedule is published
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();

  async function checkAudience() {
    const r = await act({ action: "audience_check" });
    if (!r.ok) { setMsg({ ok: false, text: "ตรวจรายชื่อไม่สำเร็จ" }); return; }
    setMissed({ list: (r.j.missed ?? []) as Array<{ userId: number; name: string; reasonText: string }>, sentNote: `พร้อมรับแจ้ง ${r.j.reachable ?? 0}/${r.j.total ?? 0} คน` });
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-ink">ตำแหน่งงานค่าตอบแทนพิเศษ</h1>
        <p className="text-sm text-slate-500 mt-1">ดูผู้ที่เลือกวัน จัดวันที่ว่าง และประกาศตารางของสาขา</p>
        <div className="flex gap-2 mt-2 text-sm">
          <a href={apiUrl(`/admin/persona/special-duty/settings?month=${month}`)} className="chip">ตั้งค่าตำแหน่ง</a>
          <a href={apiUrl(`/admin/persona/special-duty/overview?month=${month}`)} className="chip">ภาพรวมทุกสาขา</a>
        </div>
      </div>

      <div className="card flex items-center justify-between gap-2">
        <button type="button" className="chip whitespace-nowrap" onClick={() => router.push(`?month=${shiftMonth(month, -1)}`)}>เดือนก่อน</button>
        <div className="text-center">
          <div className="font-semibold text-ink">เดือน{MONTHS[m - 1]} {y + 543}</div>
          <span className={`tag mt-1 ${st === "off" || st === "settled" ? "tag-mute" : st === "special_published" || st === "in_progress" ? "tag-ok" : "tag-warn"}`}>{STATUS_TH[st] ?? st}{st === "booking_open" && data.month.bookingCloseDate ? ` · ปิดรับวันที่ ${fmtDate(data.month.bookingCloseDate)}` : ""}</span>
        </div>
        <button type="button" className="chip whitespace-nowrap" onClick={() => router.push(`?month=${shiftMonth(month, 1)}`)}>เดือนถัดไป</button>
      </div>

      {msg && <div className={`card text-sm ${msg.ok ? "text-emerald-700" : "text-rose-700"}`}>{msg.text}</div>}

      {!data.month.enabled ? <EmptyState>เดือนนี้ยังไม่เปิดใช้ตำแหน่งงานค่าตอบแทนพิเศษ</EmptyState> : (
        <>
          <div className="card space-y-2">
            <h2 className="font-bold text-ink">ขั้นตอน</h2>
            {st === "awaiting_roster" && (
              <>
                <p className="text-sm text-slate-600">เมื่อประกาศตารางงานประจำเดือนของสาขานี้ ระบบจะเปิดให้พนักงานเลือกวันและแจ้งผ่าน LINE ให้โดยอัตโนมัติ หรือกดปุ่มด้านล่างเพื่อเปิดให้เลือกวันของสาขานี้ทันที (แต่ละสาขาเปิดแยกกัน ไม่เกี่ยวกับสาขาอื่น)</p>
                <label className="field !w-auto max-w-[16rem]"><span>วันปิดรับของสาขานี้ <span className="text-slate-400">(เว้นว่าง = ตามเกณฑ์ของสาขา)</span></span><input type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} /></label>
                <button type="button" className="btn-primary" disabled={busy} onClick={async () => {
                  if (!window.confirm("เปิดให้พนักงานสาขานี้เลือกวัน และส่งข้อความ LINE ให้พนักงานที่มีสิทธิ์ตอนนี้เลยไหม")) return;
                  const r = await act({ action: "open_booking", ...(closeDate ? { close_date: closeDate } : {}) });
                  if (!r.ok) { setMsg({ ok: false, text: r.j.error === "no_roster" ? "สาขานี้ยังไม่มีตารางงานของเดือนนี้ ลงตารางงานก่อนจึงเปิดให้เลือกวันได้" : r.j.error === "not_awaiting_roster" ? "เดือนนี้เปิดให้เลือกวันไปแล้ว" : "เปิดไม่สำเร็จ" }); return; }
                  const { recipients = 0, sent = 0, noLine = 0 } = r.j as { recipients?: number; sent?: number; noLine?: number };
                  setMissed({ list: (r.j.missed ?? []) as Array<{ userId: number; name: string; reasonText: string }>, sentNote: `ส่ง LINE สำเร็จ ${sent}/${recipients} คน` });
                  done(`เปิดให้เลือกวันแล้ว · ส่ง LINE ${sent}/${recipients} คน${noLine ? ` (ไม่มี LINE ${noLine} คน — เข้าเลือกได้เองในระบบ)` : ""}`);
                }}>เปิดให้พนักงานสาขานี้เลือกวัน และส่ง LINE</button>
              </>
            )}
            {st === "booking_open" && (
              <>
                <p className="text-sm text-slate-600">พนักงานเลือกวันเองได้จนถึงวันปิดรับ หากต้องการเพิ่มผู้ปฏิบัติงานเอง กดช่อง “ว่าง” ในปฏิทินด้านล่าง</p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-slate-50 px-3 py-2">
                  <span className="text-sm font-medium text-slate-700">ปิดรับวันที่</span>
                  <input type="date" className="input !w-auto !py-1.5" value={closeDate || data.month.bookingCloseDate || ""} onChange={(e) => setCloseDate(e.target.value)} />
                  {closeDate && closeDate !== data.month.bookingCloseDate && (
                    <button type="button" className="btn-primary !py-1.5" disabled={busy} onClick={async () => {
                      const r = await act({ action: "set_close_date", close_date: closeDate });
                      r.ok ? done(`ตั้งวันปิดรับเป็น ${fmtDate(closeDate)} แล้ว`) : setMsg({ ok: false, text: ERR[r.j.error] ?? "ตั้งวันปิดรับไม่สำเร็จ" });
                    }}>บันทึกวันที่</button>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className="btn-primary" disabled={busy} onClick={async () => {
                    if (!window.confirm("ส่งข้อความ LINE ให้พนักงานที่มีสิทธิ์เข้ามาเลือกวันตำแหน่งงานค่าตอบแทนพิเศษตอนนี้เลยไหม")) return;
                    const r = await act({ action: "invite_booking" });
                    if (!r.ok) { setMsg({ ok: false, text: r.j.error === "booking_not_open" ? "ขณะนี้ไม่ได้อยู่ในช่วงเปิดให้เลือกวัน" : "ส่งไม่สำเร็จ" }); return; }
                    const { recipients = 0, sent = 0, noLine = 0 } = r.j as { recipients?: number; sent?: number; noLine?: number };
                    setMissed({ list: (r.j.missed ?? []) as Array<{ userId: number; name: string; reasonText: string }>, sentNote: `ส่ง LINE สำเร็จ ${sent}/${recipients} คน` });
                    setMsg({ ok: true, text: `ส่งให้พนักงานเลือกวันแล้ว · LINE ${sent}/${recipients} คน${noLine ? ` (ไม่มี LINE ${noLine} คน — เข้าเลือกได้เองจากหน้าแรกของ PERSONA)` : ""}` });
                  }}>ส่งให้พนักงานเข้ามาเลือกวัน</button>
                  <button type="button" className="btn-secondary" disabled={busy} onClick={checkAudience}>ตรวจว่าใครไม่ได้รับแจ้งเตือน</button>
                  <button type="button" className="ml-auto text-sm text-rose-600 hover:underline disabled:opacity-50" disabled={busy} onClick={async () => {
                    if (!window.confirm("ปิดรับการเลือกวันก่อนกำหนด พนักงานจะเลือกวันเองไม่ได้อีก ต้องการปิดไหม")) return;
                    const r = await act({ action: "close_booking" }); r.ok ? done("ปิดรับการเลือกวันแล้ว") : setMsg({ ok: false, text: ERR[r.j.error] ?? "ทำรายการไม่สำเร็จ" });
                  }}>ปิดรับก่อนกำหนด</button>
                </div>
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
            {["booking_open", "booking_closed", "filling"].includes(st) && (
              <>
                {st !== "booking_open" && (
                  <div><button type="button" className="btn-secondary" disabled={busy} onClick={checkAudience}>ตรวจว่าใครไม่ได้รับแจ้งเตือน</button></div>
                )}
                {missed && (
                  <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold text-slate-700">{missed.sentNote}</div>
                      <button type="button" className="text-xs text-slate-400 hover:text-slate-600" onClick={() => setMissed(null)}>ซ่อน</button>
                    </div>
                    {missed.list.length === 0
                      ? <div className="text-emerald-700">ทุกคนในสาขาผูก LINE และมีสิทธิ์ครบ ไม่มีใครตกหล่น</div>
                      : (
                        <>
                          <div className="text-amber-700">ไม่ได้รับแจ้งเตือน {missed.list.length} คน</div>
                          <ul className="divide-y divide-slate-100">
                            {missed.list.map((p) => <li key={p.userId} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1"><span className="text-slate-800">{p.name}</span><span className="text-xs text-slate-500">{p.reasonText}</span></li>)}
                          </ul>
                          <div className="text-xs text-slate-500 space-y-0.5">
                            {missed.list.some((p) => p.reasonText.includes("แผนก")) && (
                              <div>แก้ได้สองทาง: <a className="text-brand underline" href={apiUrl(`/admin/persona/special-duty/settings?month=${month}`)}>เปิดกลุ่มงานของตำแหน่งให้ครอบคลุม</a> (ไม่เลือกกลุ่มเลย = ทุกฝ่าย) หรือตั้งฝ่ายของพนักงานที่ <a className="text-brand underline" href={apiUrl("/admin/persona/employees")}>หน้าพนักงาน</a></div>
                            )}
                            {missed.list.some((p) => p.reasonText.includes("LINE")) && <div>คนที่ยังไม่ผูก LINE ต้องผูกบัญชีที่แอปก่อนจึงจะได้ข้อความ</div>}
                            <div className="text-[11px] text-slate-400">คนเหล่านี้ยังเข้าเลือกวันเองได้จากแถบสีเหลืองบนหน้าแรกของ PERSONA</div>
                          </div>
                        </>
                      )}
                  </div>
                )}
              </>
            )}
            {["special_published", "in_progress", "settled"].includes(st) && <p className="text-sm text-slate-600">ประกาศตารางแล้ว พนักงานในสาขาเห็นรายชื่อผู้ปฏิบัติงานแต่ไม่เห็นค่าตอบแทน</p>}
          </div>

          {data.swaps.length > 0 && (
            <div className="card space-y-2 !border-brand/40">
              <h2 className="font-bold text-ink">คำขอสลับวันรออนุมัติ ({data.swaps.length})</h2>
              {data.swaps.map((x) => (
                <div key={x.id} className="rounded-xl border border-[var(--card-border)] bg-[var(--surface-field)] px-3 py-2 text-sm space-y-2">
                  <div className="text-slate-700">{x.fromName} ให้วันที่ {fmtDate(x.a.date)} ({x.a.positionName}) แลกกับวันที่ {fmtDate(x.b.date)} ({x.b.positionName}) ของ {x.toName}</div>
                  {x.note && <div className="text-slate-600">เหตุผลของผู้ขอ: {x.note}</div>}
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className="btn-primary" disabled={busy} onClick={async () => { const r = await act({ action: "approve_swap", swap_id: x.id }); r.ok ? done("อนุมัติการสลับวันแล้ว วันของทั้งสองคนเปลี่ยนเรียบร้อย") : setMsg({ ok: false, text: r.j.message ?? "อนุมัติไม่สำเร็จ" }); }}>อนุมัติ</button>
                    <input className="input flex-1 min-w-[10rem]" placeholder="เหตุผลที่ไม่อนุมัติ" value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} />
                    <button type="button" className="btn-secondary" disabled={busy || rejectNote.trim().length < 3} onClick={async () => { const r = await act({ action: "reject_swap", swap_id: x.id, note: rejectNote }); r.ok ? done("ไม่อนุมัติการสลับวันแล้ว") : setMsg({ ok: false, text: r.j.message ?? "ทำรายการไม่สำเร็จ" }); }}>ไม่อนุมัติ</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {data.changes?.length > 0 && (
            <div className="card space-y-2 !border-brand/40">
              <h2 className="font-bold text-ink">คำขอเปลี่ยนผู้ปฏิบัติงานรออนุมัติ ({data.changes.length})</h2>
              {data.changes.map((c) => (
                <ChangeRequestRow key={c.id} c={c} month={month} busy={busy}
                  decide={async (body, okText) => { const r = await act({ ...body, request_id: c.id }); r.ok ? done(okText) : setMsg({ ok: false, text: r.j.message ?? "ทำรายการไม่สำเร็จ" }); }} />
              ))}
            </div>
          )}

          {data.summary && ["special_published", "in_progress", "settled"].includes(st) && (
            <div className="card space-y-2">
              <h2 className="font-bold text-ink">ค่าตอบแทนของเดือนนี้</h2>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="kpi kpi-ok"><div className="kpi-label">ตรวจรับแล้ว {data.summary.approvedDays} วัน</div><div className="text-lg font-extrabold tabular-nums text-slate-800">{data.summary.approvedAmount.toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท</div></div>
                <div className="kpi kpi-warn"><div className="kpi-label">ยังไม่ตรวจรับ {data.summary.pendingDays} วัน</div><div className="text-lg font-extrabold tabular-nums text-slate-800">ขาด {data.summary.absentDays} วัน</div></div>
              </div>
              <p className="text-sm text-slate-600">งบสูงสุดของเดือน {data.summary.budget.toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท (ทุกวัน ทุกตำแหน่ง) · วันที่ไม่มีผู้ปฏิบัติ {data.summary.unfilledDays} วัน</p>
              <p className="text-xs text-slate-500">จ่ายเฉพาะวันที่ตรวจรับแล้ว พร้อมค่าบริการวันที่ 20 ของเดือนถัดไป พนักงานที่หักภาษี ณ ที่จ่ายถูกหัก 3% พนักงานในประกันสังคมไม่ถูกหัก</p>
              {data.alerts.length > 0 && <ul className="text-sm text-rose-700 list-disc pl-5">{data.alerts.map((a, i) => <li key={i}>{a.text}</li>)}</ul>}
            </div>
          )}

          {plan && (
            <div className="card space-y-2 !border-brand/40">
              <h2 className="font-bold text-ink">ข้อเสนอของระบบ (ยังไม่บันทึก)</h2>
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
            <Sheet onClose={() => setPick(null)}>
              <h2 className="text-lg font-bold text-ink">เลือกผู้ปฏิบัติงาน</h2>
              <p className="text-sm text-slate-600">{pick.positionName} · {fmtDate(pick.date)}</p>
              {pick.list.length === 0 ? <p className="text-sm text-rose-700">ไม่มีพนักงานที่ตรงเงื่อนไขในวันนี้ (ต้องมีตารางทำงาน ไม่ลา และอยู่ในกลุ่มงานที่กำหนด) — เลือกจากรายชื่อด้านล่างแบบข้ามเงื่อนไขได้</p> : (
                <div className="flex flex-wrap gap-2">
                  {pick.list.map((u) => (
                    <button key={u.id} type="button" className="btn-secondary" disabled={busy} onClick={async () => {
                      const r = await act({ action: "assign", position_id: pick.positionId, date: pick.date, user_id: u.id });
                      r.ok ? done("มอบหมายเรียบร้อยแล้ว") : setMsg({ ok: false, text: (r.j.errors ?? []).map((e: { message: string }) => e.message).join("\n") || "มอบหมายไม่สำเร็จ" });
                    }}>{u.name}</button>
                  ))}
                </div>
              )}
              {pick.others.length > 0 && (
                <div className="space-y-1.5 border-t border-[var(--card-border)] pt-2">
                  <p className="text-xs font-bold text-slate-500">พนักงานที่ไม่ตรงเงื่อนไข — กดเพื่อมอบหมายแบบข้ามเงื่อนไข (ระบบจะถามยืนยันและบันทึกไว้)</p>
                  <div className="flex flex-wrap gap-2">
                    {pick.others.map((u) => (
                      <button key={u.id} type="button" disabled={busy || !u.overridable} title={u.reasons.join(" · ")}
                        className="chip !h-auto !flex-col !items-start !gap-0 !rounded-2xl !whitespace-normal !py-1.5 text-left disabled:opacity-40"
                        onClick={async () => {
                          if (!window.confirm(`มอบหมาย ${u.name} แบบข้ามเงื่อนไขใช่หรือไม่\n• ${u.reasons.join("\n• ")}`)) return;
                          const r = await act({ action: "assign", position_id: pick.positionId, date: pick.date, user_id: u.id, override: true });
                          r.ok ? done("มอบหมายเรียบร้อยแล้ว (ข้ามเงื่อนไข)") : setMsg({ ok: false, text: (r.j.errors ?? []).map((e: { message: string }) => e.message).join("\n") || "มอบหมายไม่สำเร็จ" });
                        }}>
                        <span className="font-semibold">{u.name}</span>
                        <span className="text-[11px] font-normal text-slate-500">{u.reasons.join(" · ")}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex justify-end pt-1"><button type="button" className="btn-secondary" onClick={() => setPick(null)}>ปิด</button></div>
            </Sheet>
          )}

          {selected && (
            <Sheet onClose={() => setSelected(null)}>
              <h2 className="text-lg font-bold text-ink">{selected.name}</h2>
              <p className="text-sm text-slate-600">{fmtDate(selected.date)} · {selected.source === "booked" ? "เลือกเอง" : "ผู้จัดการมอบหมาย"} · {DAY_STATUS[selected.status] ?? selected.status}</p>
              {selected.performerName && <p className="text-sm text-brand">ผู้ปฏิบัติแทน: {selected.performerName}</p>}
              {selected.replacement && (
                <p className="rounded-lg bg-violet-50 px-3 py-2 text-sm text-violet-900">เปลี่ยนผู้ปฏิบัติงานจาก <b>{selected.replacement.fromName}</b> เป็น <b>{selected.replacement.toName}</b> · สาเหตุ: {selected.replacement.reasonText}</p>
              )}
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
                      <img src={apiUrl(`/api/special-duty/photo/${ph.id}`)} alt="หลักฐาน" className="h-32 w-32 sm:h-36 sm:w-36 rounded-lg object-cover border border-slate-200" />
                    </a>
                  ))}
                </div>
              )}
              {flags.length > 0 && (
                <div className="rounded-xl border border-rose-300 bg-rose-50 px-3 py-2.5 text-sm text-rose-900 space-y-1">
                  <div className="font-bold">⚠️ ตรวจพบสัญญาณภาพซ้ำ — โปรดดูก่อนตรวจรับ</div>
                  {flags.map((f, i) => (
                    <div key={i}>
                      {f.kind === "identical" && f.other && <>• ภาพที่ {photos.findIndex((p) => p.id === f.photoId) + 1} <b>เป็นไฟล์เดียวกัน</b>กับภาพที่เคยส่งของ {f.other.positionName} วันที่ {fmtDate(f.other.date)} ({f.other.performerName}{f.other.branchName ? ` · ${f.other.branchName}` : ""})</>}
                      {f.kind === "similar" && f.other && <>• ภาพที่ {photos.findIndex((p) => p.id === f.photoId) + 1} <b>เหมือนภาพเดิมมาก</b> (ย่อหรือบันทึกซ้ำจากภาพเดียวกัน) กับ {f.other.positionName} วันที่ {fmtDate(f.other.date)} ({f.other.performerName})</>}
                      {f.kind === "older_photo" && <>• ภาพที่ {photos.findIndex((p) => p.id === f.photoId) + 1} <b>ถ่ายก่อนวันปฏิบัติงาน</b> (ไฟล์ลงวันที่ {f.takenAt ? fmtDate(f.takenAt) : "ก่อนหน้า"})</>}
                    </div>
                  ))}
                  <div className="text-xs text-rose-700">เป็นเพียงสัญญาณเตือน ผู้จัดการเป็นผู้ตัดสิน — พื้นที่เดียวกันถ่ายใหม่ทุกวันไม่ถือว่าซ้ำ</div>
                </div>
              )}
              {selected.status === "submitted" && (
                <div className="space-y-2">
                  <input className="input w-full" placeholder="เหตุผล (ต้องกรอกเมื่อส่งกลับ)" value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} />
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="btn-primary" disabled={busy || !selected.presentAtWork} onClick={async () => { if (flags.length > 0 && !window.confirm("พบสัญญาณภาพซ้ำในหลักฐานนี้ ยังต้องการตรวจรับหรือไม่")) return; const r = await act({ action: "approve", day_id: selected.id }); r.ok ? done("ตรวจรับเรียบร้อยแล้ว") : setMsg({ ok: false, text: r.j.message ?? "ตรวจรับไม่สำเร็จ" }); }}>ตรวจรับ</button>
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
              {["booked", "assigned", "covered", "submitted"].includes(selected.status) && ["special_published", "in_progress"].includes(st) && (
                <div className="space-y-2 rounded-xl border border-slate-200 p-3">
                  {!replacing ? (
                    <button type="button" className="btn-secondary" disabled={busy} onClick={() => startReplace(selected)}>{selected.status === "submitted" ? "คนที่ทำจริงไม่ใช่คนนี้ — เปลี่ยนผู้ได้รับค่าตอบแทน" : "เปลี่ยนผู้ปฏิบัติงาน (ลาป่วย / เหตุอื่น)"}</button>
                  ) : (
                    <>
                      <div className="text-sm font-medium text-slate-700">{selected.status === "submitted" ? "ระบุคนที่ทำงานจริงวันนี้ — ค่าตอบแทนจะจ่ายให้คนนี้ (ต้องมีการลงเวลาเข้างานปกติของวันนั้น)" : "เปลี่ยนผู้ปฏิบัติงานวันนี้ · ไม่นับเป็นการขาดของผู้เดิม"}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {([["sick", "ลาป่วย"], ["personal", "ธุระส่วนตัว"], ["emergency", "เหตุฉุกเฉิน"], ["other", "อื่นๆ"]] as const).map(([k, label]) => (
                          <button key={k} type="button" aria-pressed={repReason === k} className={`chip ${repReason === k ? "chip-active" : ""}`} onClick={() => setRepReason(k)}>{label}</button>
                        ))}
                      </div>
                      <input className="input w-full" placeholder={repReason === "other" ? "ระบุสาเหตุ (จำเป็น)" : "รายละเอียดเพิ่มเติม (ถ้ามี)"} maxLength={200} value={repNote} onChange={(e) => setRepNote(e.target.value)} />
                      <p className="text-xs text-slate-500">เลือกผู้ปฏิบัติแทน (ต้องมีตารางทำงานในวันนั้น ไม่ลา และอยู่ในกลุ่มงานที่กำหนด)</p>
                      {subs == null ? <p className="text-sm text-slate-500">กำลังโหลด</p> : subs.length === 0 ? <p className="text-sm text-rose-700">ไม่มีผู้ที่แทนได้ในวันนี้</p> : (
                        <div className="flex flex-wrap gap-2">
                          {subs.map((u) => (
                            <button key={u.id} type="button" className="btn-secondary" disabled={busy || !repReason || (repReason === "other" && repNote.trim().length < 3)} onClick={async () => {
                              if (!window.confirm(`เปลี่ยนผู้ปฏิบัติงานเป็น ${u.name} ใช่หรือไม่`)) return;
                              const r = await act({ action: "replace", day_id: selected.id, user_id: u.id, reason_type: repReason, note: repNote.trim() || undefined });
                              r.ok ? done("เปลี่ยนผู้ปฏิบัติงานแล้ว และแจ้งทั้งสองคนทาง LINE") : setMsg({ ok: false, text: r.j.message ?? "ทำรายการไม่สำเร็จ" });
                            }}>{u.name}</button>
                          ))}
                        </div>
                      )}
                      {!repReason && <p className="text-xs text-amber-700">เลือกสาเหตุก่อน จึงจะเลือกผู้ปฏิบัติแทนได้</p>}
                    </>
                  )}
                </div>
              )}
              <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                {["booked", "assigned", "submitted", "covered"].includes(selected.status) && ["special_published", "in_progress"].includes(st) && selected.date <= new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10) && (
                  <button type="button" className="btn-secondary" disabled={busy} onClick={async () => { if (!window.confirm("บันทึกว่าผู้ปฏิบัติงานขาดในวันนี้ใช่หรือไม่ รายการนี้นับเป็นการขาดหนึ่งครั้งของผู้ที่ได้รับมอบหมาย")) return; const r = await act({ action: "absent", day_id: selected.id }); r.ok ? done("บันทึกการขาดแล้ว เลือกผู้ปฏิบัติแทนได้ที่ช่องวันนี้") : setMsg({ ok: false, text: r.j.message ?? "ทำรายการไม่สำเร็จ" }); }}>บันทึกว่าขาด</button>
                )}
                {canEdit && <button type="button" className="btn-secondary" disabled={busy} onClick={async () => { const r = await act({ action: "remove", day_id: selected.id }); r.ok ? done("ถอนวันนี้ออกแล้ว") : setMsg({ ok: false, text: ERR[r.j.error] ?? "ถอนไม่สำเร็จ" }); }}>ถอนออก</button>}
                <button type="button" className="btn-secondary sm:ml-auto" onClick={() => setSelected(null)}>ปิด</button>
              </div>
            </Sheet>
          )}

          {data.positions.map((p) => {
            const byDate = new Map(data.rows.filter((r) => r.positionId === p.id).map((r) => [r.date, r]));
            const openSet = new Set(data.open.filter((o) => o.positionId === p.id).map((o) => o.date));
            const cells: Array<number | null> = [...Array(first).fill(null), ...Array.from({ length: last }, (_, i) => i + 1)];
            return (
              <section key={p.id} className="card space-y-2">
                <h2 className="font-bold text-ink">{p.name}</h2>
                <div className="grid grid-cols-7 gap-1 text-center text-xs text-slate-500">{HEAD.map((h) => <div key={h}>{h}</div>)}</div>
                <div className="grid grid-cols-7 gap-1">
                  {cells.map((d, i) => {
                    if (d == null) return <div key={`b${i}`} />;
                    const date = `${month}-${String(d).padStart(2, "0")}`;
                    const row = byDate.get(date);
                    const isOpen = openSet.has(date);
                    return (
                      <button key={date} type="button" disabled={!row && !(canEdit && isOpen)}
                        onClick={async () => {
                          if (row) { await open_(row); return; }
                          const r = await fetch(apiUrl(`/api/admin/persona/special-duty?month=${month}&candidates=${p.id}:${date}`), { cache: "no-store" });
                          const j = await r.json(); setSelected(null);
                          setPick({ positionId: p.id, positionName: p.name, date, list: j.candidates ?? [], others: j.others ?? [] });
                        }}
                        className={`rounded-xl border px-0.5 py-1 text-center leading-tight min-h-[3.2rem] ${row ? (row.status === "approved" ? "border-emerald-600 bg-emerald-200" : row.status === "submitted" ? "border-amber-500 bg-amber-100" : row.status === "absent" ? "border-rose-600 bg-rose-200" : row.status === "covered" ? "border-brand/50 bg-brand/10" : row.source === "booked" ? "border-emerald-300 bg-emerald-50" : "border-sky-300 bg-sky-50") : isOpen ? "border-rose-300 bg-rose-50" : "border-[var(--card-border)] text-slate-300"}`}>
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

// One employee request to hand a day over: approve (to the person they suggested, or one the manager picks) or refuse with a reason.
function ChangeRequestRow({ c, month, busy, decide }: {
  c: { id: number; dayId: number; date: string; positionName: string; requesterName: string; proposedId: number | null; proposedName: string | null; reasonText: string };
  month: string; busy: boolean; decide: (body: Record<string, unknown>, okText: string) => Promise<void>;
}) {
  const [cands, setCands] = useState<Array<{ id: number; name: string }> | null>(null);
  const [pick, setPick] = useState<number | null>(c.proposedId);
  const [note, setNote] = useState("");
  const loadCands = async () => { const r = await fetch(apiUrl(`/api/admin/persona/special-duty?month=${month}&substitutes=${c.dayId}`), { cache: "no-store" }); const j = await r.json(); setCands(j.candidates ?? []); };
  const pickedName = pick == null ? null : pick === c.proposedId ? c.proposedName : cands?.find((x) => x.id === pick)?.name ?? null;
  return (
    <div className="rounded-xl border border-[var(--card-border)] bg-[var(--surface-field)] px-3 py-2 text-sm space-y-2">
      <div className="text-slate-700"><b>{c.requesterName}</b> ขอเปลี่ยนผู้ปฏิบัติงาน {c.positionName} วันที่ {fmtDate(c.date)}</div>
      <div className="text-slate-600">สาเหตุ: {c.reasonText}</div>
      <div className="text-slate-600">{c.proposedName ? `เสนอให้ ${c.proposedName} ทำแทน` : "ไม่ได้เสนอผู้ทำแทน — เลือกเองได้"}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        {cands == null ? <button type="button" className="chip" onClick={loadCands}>{c.proposedName ? "เปลี่ยนคนแทน" : "เลือกคนแทน"}</button>
          : cands.length === 0 ? <span className="text-xs text-rose-700">ไม่มีผู้ที่แทนได้ในวันนี้</span>
          : cands.map((u) => <button key={u.id} type="button" aria-pressed={pick === u.id} className={`chip ${pick === u.id ? "chip-active" : ""}`} onClick={() => setPick(u.id)}>{u.name}</button>)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary" disabled={busy || pick == null} onClick={() => { if (window.confirm(`อนุมัติให้ ${pickedName ?? "คนที่เลือก"} ปฏิบัติงานแทน ${c.requesterName} ใช่หรือไม่`)) decide({ action: "approve_change", user_id: pick }, "อนุมัติการเปลี่ยนผู้ปฏิบัติงานแล้ว"); }}>อนุมัติ{pickedName ? ` (${pickedName})` : ""}</button>
        <input className="input flex-1 min-w-[10rem]" placeholder="เหตุผลที่ไม่อนุมัติ" value={note} onChange={(e) => setNote(e.target.value)} />
        <button type="button" className="btn-secondary" disabled={busy || note.trim().length < 3} onClick={() => decide({ action: "reject_change", note }, "ไม่อนุมัติคำขอแล้ว")}>ไม่อนุมัติ</button>
      </div>
    </div>
  );
}
