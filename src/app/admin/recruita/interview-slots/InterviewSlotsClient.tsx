"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { formatLongDate } from "@/lib/time";
import type { AdminInterviewSlot, InterviewApplicant } from "@/lib/recruita-interview-slots";
import { useConfirm } from "@/app/components/useConfirm";

// Thai week, calendar order (Mon first). idx = JS getUTCDay() value.
const WEEKDAYS: Array<{ idx: number; label: string; short: string }> = [
  { idx: 1, label: "จันทร์", short: "จ" },
  { idx: 2, label: "อังคาร", short: "อ" },
  { idx: 3, label: "พุธ", short: "พ" },
  { idx: 4, label: "พฤหัสบดี", short: "พฤ" },
  { idx: 5, label: "ศุกร์", short: "ศ" },
  { idx: 6, label: "เสาร์", short: "ส" },
  { idx: 0, label: "อาทิตย์", short: "อา" }
];
const WD_NAME: Record<number, string> = Object.fromEntries(
  WEEKDAYS.map((w) => [w.idx, w.label])
);

function weekdayOf(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const DURATION_OPTS = [15, 30, 45, 60, 90, 120];

export default function InterviewSlotsClient({
  slots, today, lockedMinutes = null, currentMinutes = null, applicants = [], mapUrl = ""
}: {
  slots: AdminInterviewSlot[];
  today: string;
  /** Slot length is locked to this many minutes once a booking exists. */
  lockedMinutes?: number | null;
  /** Current slot length (from existing slots) to default the picker to. */
  currentMinutes?: number | null;
  /** Interview-stage applicants the admin can book an open slot for. */
  applicants?: InterviewApplicant[];
  /** Venue map/navigation link (shared with the invite-card button). */
  mapUrl?: string;
}) {
  const { confirm, ConfirmDialog } = useConfirm();
  const router = useRouter();
  const [, startTransition] = useTransition();

  // Config form — defaults mirror the owner's example (Sat+Sun, 12:00–15:00).
  const [weekdays, setWeekdays] = useState<Set<number>>(new Set([6, 0]));
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [startTime, setStartTime] = useState("12:00");
  const [endTime, setEndTime] = useState("15:00");
  const [location, setLocation] = useState("");
  // Slot length (minutes). When locked (a booking exists) it's pinned to
  // lockedMinutes; otherwise defaults to the current length or 60.
  const [slotMinutes, setSlotMinutes] = useState<number>(
    lockedMinutes ?? currentMinutes ?? 60
  );

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  function toggleWeekday(idx: number) {
    setWeekdays((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  }

  async function generate() {
    setMsg(null);
    if (weekdays.size === 0) { setMsg({ kind: "err", text: "เลือกวันในสัปดาห์อย่างน้อย 1 วัน" }); return; }
    if (!fromDate || !toDate) { setMsg({ kind: "err", text: "เลือกช่วงวันที่" }); return; }
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/recruita/interview-slots/generate"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_date: fromDate, to_date: toDate,
          weekdays: Array.from(weekdays),
          start_time: startTime, end_time: endTime,
          location: location.trim() || undefined,
          slot_minutes: slotMinutes
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: j.message ?? j.error ?? "สร้างช่วงเวลาไม่สำเร็จ" });
        return;
      }
      setMsg({
        kind: "ok",
        text: `สร้าง ${j.created} ช่วงเวลาแล้ว${j.skipped ? ` (ข้าม ${j.skipped} ช่วงที่มีอยู่แล้ว)` : ""}`
      });
      startTransition(() => router.refresh());
    } catch {
      setMsg({ kind: "err", text: "เกิดข้อผิดพลาด ลองใหม่อีกครั้ง" });
    } finally { setBusy(false); }
  }

  async function deleteSlot(id: number) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/recruita/interview-slots/${id}`), { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: j.message ?? "ลบไม่สำเร็จ" });
        return;
      }
      startTransition(() => router.refresh());
    } finally { setBusy(false); }
  }

  async function clearOpen() {
    const ok = await confirm({ title: "ล้างช่วงเวลาที่ยังว่างทั้งหมด?", body: "(ช่วงที่ถูกจองแล้วจะไม่ถูกลบ)", confirmLabel: "ล้าง", cancelLabel: "ยกเลิก", variant: "danger" });
    if (ok === null) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/recruita/interview-slots/clear-open"), { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setMsg({ kind: "err", text: "ล้างไม่สำเร็จ" }); return; }
      setMsg({ kind: "ok", text: `ล้างช่วงว่าง ${j.removed} ช่วงแล้ว` });
      startTransition(() => router.refresh());
    } finally { setBusy(false); }
  }

  // Venue map link (owner 2026-06-11: "ยังไม่มีให้แปะลิงค์สถานที่นัด
  // สัมภาษณ์") — editable here, shared with the invite-card navigate button.
  const [mapLinkInput, setMapLinkInput] = useState(mapUrl);
  const [mapBusy, setMapBusy] = useState(false);
  async function saveMapLink() {
    setMapBusy(true);
    setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/recruita/interview-slots/location-link"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ map_url: mapLinkInput.trim() })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setMsg({ kind: "err", text: j.message ?? "บันทึกลิงก์ไม่สำเร็จ" }); return; }
      setMsg({ kind: "ok", text: "บันทึกลิงก์สถานที่แล้ว" });
      startTransition(() => router.refresh());
    } finally { setMapBusy(false); }
  }

  // Admin books an open slot ON BEHALF of an applicant (owner 2026-06-11).
  // assignSlotId = the slot whose applicant-picker is open.
  const [assignSlotId, setAssignSlotId] = useState<number | null>(null);
  const [assignAppId, setAssignAppId] = useState("");
  async function assignSlot(slotId: number) {
    if (!assignAppId) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/recruita/interview-slots/${slotId}/assign`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ application_id: Number(assignAppId) })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: j.message ?? j.error ?? "ลงนัดไม่สำเร็จ" });
        return;
      }
      setMsg({ kind: "ok", text: "ลงนัดสัมภาษณ์ให้ผู้สมัครเรียบร้อยแล้ว" });
      setAssignSlotId(null);
      setAssignAppId("");
      startTransition(() => router.refresh());
    } finally { setBusy(false); }
  }

  // Lock / unlock an appointment so the candidate can't reschedule (owner
  // 2026-06-17). Admins can still move it via assign.
  async function confirmInterview(appId: number, confirmed: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/recruita/applications/${appId}/interview-confirm`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: j.message ?? j.error ?? "ทำรายการไม่สำเร็จ" });
        return;
      }
      setMsg({ kind: "ok", text: confirmed ? "ยืนยันนัด — ผู้สมัครจะเปลี่ยนเวลาเองไม่ได้แล้ว" : "ปลดล็อก — ผู้สมัครเปลี่ยนเวลาได้อีกครั้ง" });
      startTransition(() => router.refresh());
    } finally { setBusy(false); }
  }

  // Group slots by date for the board.
  const groups = useMemo(() => {
    const m = new Map<string, AdminInterviewSlot[]>();
    for (const s of slots) {
      if (!m.has(s.slot_date)) m.set(s.slot_date, []);
      m.get(s.slot_date)!.push(s);
    }
    return Array.from(m.entries());
  }, [slots]);

  const openCount = slots.filter((s) => s.status === "open").length;
  const bookedCount = slots.filter((s) => s.status === "booked").length;

  return (
    <div className="space-y-4">
      {ConfirmDialog}
      {/* Venue location link — shared with the invite-card navigate button. */}
      <div className="card space-y-2">
        <h2 className="font-bold text-slate-800 text-sm">ลิงก์สถานที่นัดสัมภาษณ์ (แผนที่/นำทาง)</h2>
        <p className="text-[11px] text-slate-500">
          วางลิงก์ Google Maps (หรือลิงก์แผนที่อื่น) ของสถานที่นัดสัมภาษณ์ — จะเป็นปุ่ม
          &quot;นำทางมาสถานที่นัดสัมภาษณ์&quot; บนการ์ดเชิญสัมภาษณ์ใน LINE ของผู้สมัคร. ปล่อยว่าง = ไม่แสดงปุ่ม.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input className="input text-sm flex-1 min-w-[220px]" type="url" inputMode="url"
            value={mapLinkInput} onChange={(e) => setMapLinkInput(e.target.value)}
            placeholder="เช่น https://maps.app.goo.gl/xxxxxxxx" maxLength={1000} />
          <button type="button" onClick={saveMapLink}
            disabled={mapBusy || mapLinkInput.trim() === (mapUrl ?? "").trim()}
            className="btn-primary text-sm py-2 px-4 disabled:opacity-50">
            {mapBusy ? "กำลังบันทึก…" : "บันทึกลิงก์"}
          </button>
          {mapLinkInput.trim() && /^https?:\/\//i.test(mapLinkInput.trim()) && (
            <a href={mapLinkInput.trim()} target="_blank" rel="noopener noreferrer"
              className="text-xs text-brand hover:underline">เปิดดู</a>
          )}
        </div>
      </div>

      {/* Config / generator */}
      <div className="card space-y-3">
        <h2 className="font-bold text-slate-800 text-sm">สร้างช่วงเวลาสัมภาษณ์</h2>
        <div>
          <label className="label">วันในสัปดาห์</label>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map((w) => {
              const on = weekdays.has(w.idx);
              return (
                <button key={w.idx} type="button" onClick={() => toggleWeekday(w.idx)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-bold border ${
                    on ? "bg-brand text-white border-brand" : "border-slate-300 text-slate-600 hover:bg-slate-50"
                  }`}>
                  {w.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div>
            <label className="label">ตั้งแต่วันที่</label>
            <input type="date" className="input text-sm" value={fromDate} min={today}
              onChange={(e) => setFromDate(e.target.value)} />
          </div>
          <div>
            <label className="label">ถึงวันที่</label>
            <input type="date" className="input text-sm" value={toDate} min={fromDate || today}
              onChange={(e) => setToDate(e.target.value)} />
          </div>
          <div>
            <label className="label">เวลาเริ่ม</label>
            <input type="time" step={3600} className="input text-sm" value={startTime}
              onChange={(e) => setStartTime(e.target.value)} />
          </div>
          <div>
            <label className="label">เวลาสิ้นสุด</label>
            <input type="time" step={3600} className="input text-sm" value={endTime}
              onChange={(e) => setEndTime(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label">ความยาวต่อช่วง (นาที)</label>
          <select className="input text-sm" value={slotMinutes}
            disabled={lockedMinutes != null}
            onChange={(e) => setSlotMinutes(Number(e.target.value))}>
            {/* keep a locked value selectable even if it's not a preset */}
            {!DURATION_OPTS.includes(slotMinutes) && (
              <option value={slotMinutes}>{slotMinutes} นาที</option>
            )}
            {DURATION_OPTS.map((m) => <option key={m} value={m}>{m} นาที</option>)}
          </select>
          {lockedMinutes != null ? (
            <p className="text-[10px] text-amber-600 mt-1">
              มีผู้จองสัมภาษณ์แล้ว — ปรับความยาวช่วงเวลาไม่ได้ (คงไว้ที่ {lockedMinutes} นาที) เพิ่มช่วงใหม่ความยาวเดิมได้
            </p>
          ) : (
            <p className="text-[10px] text-slate-400 mt-1">
              ตั้งได้ว่าช่วงสัมภาษณ์ละกี่นาที — ล็อกอัตโนมัติเมื่อมีผู้จองแล้ว
            </p>
          )}
        </div>
        <div>
          <label className="label">สถานที่ (ทางเลือก)</label>
          <input className="input text-sm" value={location} maxLength={300}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="เช่น สาขา NAMA / Google Meet" />
        </div>
        <p className="text-[11px] text-slate-400">
          ระบบจะสร้างช่วงละ {slotMinutes} นาที ในกรอบเวลาที่กำหนด (เศษเวลาที่ไม่ครบ 1 ช่วงจะถูกข้าม)
        </p>
        {msg && (
          <p className={`text-xs ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>{msg.text}</p>
        )}
        <button type="button" onClick={generate} disabled={busy}
          className="btn-primary w-full text-sm py-2.5 disabled:opacity-50">
          {busy ? "กำลังสร้าง…" : "สร้างช่วงเวลา"}
        </button>
      </div>

      {/* Board */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="font-bold text-slate-800 text-sm">ช่วงเวลาทั้งหมด (ตั้งแต่วันนี้)</h2>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-emerald-700">ว่าง {openCount}</span>
            <span className="text-[11px] text-amber-700">จองแล้ว {bookedCount}</span>
            {openCount > 0 && (
              <button type="button" onClick={clearOpen} disabled={busy}
                className="text-[11px] px-2 py-1 rounded border border-rose-300 text-rose-600 hover:bg-rose-50 disabled:opacity-50">
                ล้างช่วงว่าง
              </button>
            )}
          </div>
        </div>

        {groups.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-6">
            ยังไม่มีช่วงเวลา — สร้างด้านบนก่อน
          </p>
        ) : (
          <div className="space-y-3">
            {groups.map(([date, daySlots]) => (
              <div key={date} className="border border-slate-200 rounded-lg overflow-hidden">
                <div className="bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-600 border-b border-slate-200">
                  {WD_NAME[weekdayOf(date)]} · {formatLongDate(date, "th")}
                </div>
                <div className="divide-y divide-slate-100">
                  {daySlots.map((s) => (
                    <div key={s.id} className="flex items-center gap-2 px-3 py-2 text-sm flex-wrap">
                      <span className="font-mono text-slate-700 tabular-nums w-[110px] flex-shrink-0">
                        {s.start_time}–{s.end_time}
                      </span>
                      {s.status === "open" ? (
                        <>
                          <span className="text-[11px] px-2 py-0.5 rounded-full font-bold bg-emerald-100 text-emerald-700">ว่าง</span>
                          {s.location && <span className="text-[11px] text-slate-400 truncate">{s.location}</span>}
                          {assignSlotId === s.id ? (
                            <div className="ml-auto flex items-center gap-1 flex-wrap justify-end">
                              <select className="input !py-0.5 !w-auto text-xs max-w-[220px]"
                                value={assignAppId} onChange={(e) => setAssignAppId(e.target.value)}>
                                <option value="">— เลือกผู้สมัคร —</option>
                                {applicants.map((a) => (
                                  <option key={a.id} value={a.id}>
                                    {a.name || "ผู้สมัคร"}{a.position_title ? ` · ${a.position_title}` : ""}{a.interview_at ? " (จองแล้ว)" : ""}
                                  </option>
                                ))}
                              </select>
                              <button type="button" disabled={busy || !assignAppId}
                                onClick={() => assignSlot(s.id)}
                                className="text-[11px] text-emerald-700 font-bold hover:underline disabled:opacity-50">
                                ลงนัด
                              </button>
                              <button type="button"
                                onClick={() => { setAssignSlotId(null); setAssignAppId(""); }}
                                className="text-[11px] text-slate-400 hover:text-slate-600">✕</button>
                            </div>
                          ) : (
                            <div className="ml-auto flex items-center gap-3">
                              {applicants.length > 0 && (
                                <button type="button" disabled={busy}
                                  onClick={() => { setAssignSlotId(s.id); setAssignAppId(""); }}
                                  className="text-[11px] text-brand font-semibold hover:underline disabled:opacity-50">
                                  ลงนัดให้ผู้สมัคร
                                </button>
                              )}
                              <button type="button" onClick={() => deleteSlot(s.id)} disabled={busy}
                                className="text-[11px] text-rose-500 hover:text-rose-700 underline disabled:opacity-50">
                                ลบ
                              </button>
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          <span className="text-[11px] px-2 py-0.5 rounded-full font-bold bg-amber-100 text-amber-800">จองแล้ว</span>
                          <span className="text-slate-700 truncate font-semibold">{s.applicant_name || "ผู้สมัคร"}</span>
                          {s.position_title && <span className="text-[11px] text-slate-400 truncate">· {s.position_title}</span>}
                          {s.booked_application_id && (
                            <button type="button" disabled={busy}
                              onClick={() => confirmInterview(s.booked_application_id!, !s.interview_confirmed)}
                              className={`text-[11px] px-2 py-0.5 rounded-full font-bold disabled:opacity-50 ${
                                s.interview_confirmed
                                  ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
                                  : "border border-slate-300 text-slate-600 hover:bg-slate-50"}`}
                              title={s.interview_confirmed ? "กดเพื่อปลดล็อก ให้ผู้สมัครเปลี่ยนเวลาได้" : "ล็อกไม่ให้ผู้สมัครเปลี่ยนเวลา/วัน"}>
                              {s.interview_confirmed ? "ยืนยันนัดแล้ว ✓" : "ยืนยันนัด (ล็อก)"}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
