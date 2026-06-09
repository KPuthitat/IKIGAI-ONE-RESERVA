"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { formatLongDate } from "@/lib/time";
import type { AdminInterviewSlot } from "@/lib/recruita-interview-slots";

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

export default function InterviewSlotsClient({
  slots, today
}: {
  slots: AdminInterviewSlot[];
  today: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  // Config form — defaults mirror the owner's example (Sat+Sun, 12:00–15:00).
  const [weekdays, setWeekdays] = useState<Set<number>>(new Set([6, 0]));
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [startTime, setStartTime] = useState("12:00");
  const [endTime, setEndTime] = useState("15:00");
  const [location, setLocation] = useState("");

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
          location: location.trim() || undefined
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
    if (!window.confirm("ล้างช่วงเวลาที่ยังว่างทั้งหมด? (ช่วงที่ถูกจองแล้วจะไม่ถูกลบ)")) return;
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
          <label className="label">สถานที่ (ทางเลือก)</label>
          <input className="input text-sm" value={location} maxLength={300}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="เช่น สาขา NAMA / Google Meet" />
        </div>
        <p className="text-[11px] text-slate-400">
          ระบบจะสร้างช่วงละ 1 ชั่วโมงในกรอบเวลาที่กำหนด เช่น 12:00–15:00 = 12:00–13:00 / 13:00–14:00 / 14:00–15:00
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
                    <div key={s.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                      <span className="font-mono text-slate-700 tabular-nums w-[110px] flex-shrink-0">
                        {s.start_time}–{s.end_time}
                      </span>
                      {s.status === "open" ? (
                        <>
                          <span className="text-[11px] px-2 py-0.5 rounded-full font-bold bg-emerald-100 text-emerald-700">ว่าง</span>
                          {s.location && <span className="text-[11px] text-slate-400 truncate">{s.location}</span>}
                          <button type="button" onClick={() => deleteSlot(s.id)} disabled={busy}
                            className="ml-auto text-[11px] text-rose-500 hover:text-rose-700 underline disabled:opacity-50">
                            ลบ
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="text-[11px] px-2 py-0.5 rounded-full font-bold bg-amber-100 text-amber-800">จองแล้ว</span>
                          <span className="text-slate-700 truncate font-semibold">{s.applicant_name || "ผู้สมัคร"}</span>
                          {s.position_title && <span className="text-[11px] text-slate-400 truncate">· {s.position_title}</span>}
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
