"use client";

import { useEffect, useState } from "react";
import type { BranchForecast } from "@/lib/forecast";

// Forward plan (owner 2026-09-27): next few days' predicted sales + holidays +
// weather + a น้องฮูก suggestion each. Fetched on its own (the weather lookup is a
// best-effort network call, so it must not block the main dashboard load).
//
// Team-tagged event notes (owner 2026-09-27: "เพิ่มโน้ตเหตุการณ์รายวันให้ทีมแท็ก
// เองด้วย") hang off each upcoming day — the team pins local context (news, a
// nearby event, a road closure) that the plan and the exec LINE card then carry.

const baht = (n: number) => `฿${Math.round(n).toLocaleString("th-TH")}`;
// Keep in sync with EVENT_NOTE_MAX in src/lib/event-notes.ts (that module pulls in
// getDb, so it can't be imported into this client component).
const EVENT_NOTE_MAX = 200;

type EventNote = { id: number; eventDate: string; note: string; createdByName: string | null };

export default function ForecastCard({ hasLineGroup, onSend }: { hasLineGroup: boolean; onSend: (days: number) => void }) {
  const [days, setDays] = useState(7);
  const [fc, setFc] = useState<BranchForecast | null>(null);
  const [loading, setLoading] = useState(true);
  const [weatherAvail, setWeatherAvail] = useState(false);

  // Team-tagged notes, grouped by date. Fetched separately from the forecast so
  // adding/removing one doesn't re-run the (network) weather lookup.
  const [notesByDate, setNotesByDate] = useState<Record<string, EventNote[]>>({});
  const [openFor, setOpenFor] = useState<string | null>(null);   // which day's input is open
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [noteErr, setNoteErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/admin/reporta/forecast?days=${days}`, { cache: "no-store" })
      .then((x) => x.json())
      .then((r) => { if (alive && r.ok) { setFc(r.forecast); setWeatherAvail(!!r.weatherAvailable); } })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [days]);

  const from = fc?.rows[0]?.date;
  const to = fc?.rows[fc.rows.length - 1]?.date;
  useEffect(() => {
    if (!from || !to) return;
    let alive = true;   // guard against an out-of-order response after a fast days-toggle
    fetch(`/api/admin/reporta/event-notes?from=${from}&to=${to}`, { cache: "no-store" })
      .then((x) => x.json())
      .then((r) => {
        if (!alive || !r.ok) return;
        const grouped: Record<string, EventNote[]> = {};
        for (const n of r.notes as EventNote[]) (grouped[n.eventDate] ??= []).push(n);
        setNotesByDate(grouped);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [from, to]);

  const addNote = async (date: string) => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true); setNoteErr(null);
    try {
      const r = await fetch("/api/admin/reporta/event-notes", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, note: text }),
      }).then((x) => x.json());
      if (r.ok && r.note) {
        setNotesByDate((prev) => ({ ...prev, [date]: [...(prev[date] ?? []), r.note] }));
        setDraft(""); setOpenFor(null);
      } else setNoteErr(r.message ?? "เพิ่มโน้ตไม่สำเร็จ");
    } catch { setNoteErr("เพิ่มโน้ตไม่สำเร็จ"); }
    finally { setBusy(false); }
  };

  const removeNote = async (date: string, id: number) => {
    if (busy) return;
    setBusy(true); setNoteErr(null);
    try {
      const r = await fetch(`/api/admin/reporta/event-notes?id=${id}`, { method: "DELETE" }).then((x) => x.json());
      // ok, or 404 (a teammate already deleted it) → drop the stale pill either way.
      if (r.ok || r.error === "not_found") setNotesByDate((prev) => ({ ...prev, [date]: (prev[date] ?? []).filter((n) => n.id !== id) }));
      else setNoteErr(r.message ?? "ลบโน้ตไม่สำเร็จ");
    } catch { setNoteErr("ลบโน้ตไม่สำเร็จ"); }
    finally { setBusy(false); }
  };

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h2 className="font-bold text-slate-800">แผนล่วงหน้า · น้องฮูกแนะนำ</h2>
          <p className="text-xs text-slate-500 mt-0.5">คาดยอดจากค่าเฉลี่ยรายวัน + โมเมนตัม · วันหยุด/อากาศ · โน้ตเหตุการณ์จากทีม{weatherAvail ? "" : " (ยังไม่ได้เชื่อมพยากรณ์อากาศ)"}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-sm">
            {[3, 7].map((d) => (
              <button key={d} type="button" onClick={() => setDays(d)}
                className={`px-3 py-1 rounded-md transition ${days === d ? "bg-white shadow-sm font-semibold text-slate-800" : "text-slate-500 hover:text-slate-700"}`}>
                {d} วัน
              </button>
            ))}
          </div>
          <button type="button" onClick={() => onSend(days)} disabled={!hasLineGroup || !fc?.hasBaseline}
            className="btn-success text-sm px-4 py-2 disabled:opacity-50" title={!hasLineGroup ? "ยังไม่ได้ตั้งกลุ่ม LINE" : undefined}>
            ส่งเข้ากลุ่ม
          </button>
        </div>
      </div>

      {noteErr && <p className="text-xs text-rose-600">{noteErr}</p>}

      {loading ? (
        <p className="text-sm text-slate-400">กำลังคำนวณ…</p>
      ) : !fc || !fc.hasBaseline ? (
        <p className="text-sm text-slate-400">ยังมีข้อมูลย้อนหลังไม่พอจะคาดการณ์ — นำเข้าไฟล์ให้ครบก่อน</p>
      ) : (
        <>
          {fc.momentumPct != null && (
            <div className="text-[11px] text-slate-500">โมเมนตัมล่าสุด (2 สัปดาห์ล่าสุด เทียบ 6 สัปดาห์ก่อน) <span className={fc.momentumPct >= 0 ? "text-emerald-600" : "text-rose-600"}>{fc.momentumPct >= 0 ? "▲" : "▼"} {Math.abs(fc.momentumPct).toFixed(1)}%</span></div>
          )}
          <div className="divide-y divide-slate-100">
            {fc.rows.map((r) => {
              const dayNotes = notesByDate[r.date] ?? [];
              return (
              <div key={r.date} className="py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-800">{r.dowLabel} {Number(r.date.slice(8, 10))}</span>
                  <span className={`text-sm font-bold tabular-nums ${r.closed ? "text-rose-500" : "text-slate-900"}`}>{r.closed ? "ปิดทำการ" : (r.predictedNett != null ? `~${baht(r.predictedNett)}` : "—")}</span>
                </div>
                {(r.holiday || (r.weather && r.weather.summary !== "อากาศปกติ")) && (
                  <div className="text-[11px] text-amber-700 mt-0.5">
                    {[r.holiday, r.weather && r.weather.summary !== "อากาศปกติ" ? `${r.weather.summary}${r.weather.tempMax != null ? ` ${Math.round(r.weather.tempMax)}°` : ""}` : null].filter(Boolean).join(" · ")}
                  </div>
                )}
                {r.suggestions.length > 0 && (
                  <ul className="mt-0.5 space-y-0.5">
                    {r.suggestions.map((s, i) => (
                      <li key={i} className="flex gap-1.5 text-[11px] text-slate-600"><span className="text-brand">•</span><span>{s}</span></li>
                    ))}
                  </ul>
                )}
                {/* Team-tagged event notes for this day */}
                {dayNotes.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {dayNotes.map((n) => (
                      <span key={n.id} className="inline-flex items-center gap-1 rounded-full bg-violet-50 text-violet-700 text-[11px] px-2 py-0.5"
                        title={n.createdByName ? `แท็กโดย ${n.createdByName}` : undefined}>
                        📌 {n.note}
                        <button type="button" onClick={() => removeNote(r.date, n.id)} disabled={busy}
                          className="text-violet-400 hover:text-rose-500 disabled:opacity-50" aria-label="ลบโน้ต">×</button>
                      </span>
                    ))}
                  </div>
                )}
                {openFor === r.date ? (
                  <div className="mt-1 flex items-center gap-1.5">
                    <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={EVENT_NOTE_MAX}
                      onKeyDown={(e) => { if (e.key === "Enter") addNote(r.date); if (e.key === "Escape") { setOpenFor(null); setDraft(""); } }}
                      placeholder="เช่น มีงานวิ่งใกล้ร้าน / ถนนปิด / เทศกาล"
                      className="flex-1 rounded-md border border-slate-200 px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-violet-300" />
                    <button type="button" onClick={() => addNote(r.date)} disabled={busy || !draft.trim()}
                      className="text-[12px] font-semibold text-violet-700 px-2 py-1 disabled:opacity-40">บันทึก</button>
                    <button type="button" onClick={() => { setOpenFor(null); setDraft(""); }}
                      className="text-[12px] text-slate-400 hover:text-slate-600 px-1 py-1">ยกเลิก</button>
                  </div>
                ) : (
                  <button type="button" onClick={() => { setOpenFor(r.date); setDraft(""); setNoteErr(null); }}
                    className="mt-1 text-[11px] text-violet-600 hover:text-violet-800">+ โน้ตเหตุการณ์</button>
                )}
              </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
