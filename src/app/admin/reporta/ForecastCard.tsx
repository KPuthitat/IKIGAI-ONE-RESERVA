"use client";

import { useEffect, useState } from "react";
import type { BranchForecast, ForecastWeather } from "@/lib/forecast";

// Forward plan (owner 2026-09-27): next few days' predicted sales + holidays +
// weather + a น้องฮูก suggestion each. Fetched on its own (the weather lookup is a
// best-effort network call, so it must not block the main dashboard load).
//
// Team-tagged event notes (owner 2026-09-27: "เพิ่มโน้ตเหตุการณ์รายวันให้ทีมแท็ก
// เองด้วย") hang off each upcoming day — the team pins local context (news, a
// nearby event, a road closure) that the plan and the exec LINE card then carry.
// A backdated section (owner 2026-09-27: "ให้ทีมแท็กโน้ตย้อนหลังได้ด้วย") lets the
// team tag past days too, for record-keeping / after-the-fact context.

const baht = (n: number) => `฿${Math.round(n).toLocaleString("th-TH")}`;
// Keep in sync with EVENT_NOTE_MAX in src/lib/event-notes.ts (that module pulls in
// getDb, so it can't be imported into this client component).
const EVENT_NOTE_MAX = 200;
const PAST_WINDOW_DAYS = 30;

function bkkToday(): string { return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10); }
function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dateLabel(iso: string): string {
  // Parse + format in UTC so the label matches the ISO calendar date regardless
  // of the viewer's browser timezone (a bare `T00:00:00` would shift a day back
  // for viewers behind UTC).
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

// Weather glyphs for the forward-plan strip (owner 2026-09-27: "มีไอคอนสภาพอากาศ
// ด้วยดีไหม"). Derived from Open-Meteo's rain chance + high temp.
function weatherIcon(w: ForecastWeather | null): string {
  if (!w) return "";
  if (w.rainChance != null && w.rainChance >= 60) return "🌧️";
  if (w.rainChance != null && w.rainChance >= 30) return "🌦️";
  if (w.tempMax != null && w.tempMax >= 35) return "☀️";
  return "⛅";
}
function weatherLine(w: ForecastWeather | null): string {
  if (!w) return "";
  const temp = w.tempMax != null
    ? (w.tempMin != null ? `${Math.round(w.tempMin)}–${Math.round(w.tempMax)}°` : `${Math.round(w.tempMax)}°`)
    : "";
  const rain = w.rainChance != null && w.rainChance >= 30 ? `💧${Math.round(w.rainChance)}%` : "";
  return [temp, rain].filter(Boolean).join("  ");
}
// Big date header the owner asked for (owner 2026-09-27: "วันที่เป็นตัวใหญ่ๆ …
// เช่น MON 28/09").
const EN_DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const bigDate = (iso: string, dow: number) => `${EN_DOW[dow] ?? ""} ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

const NOTES_URL = "/api/admin/reporta/event-notes";
async function postNote(date: string, note: string) {
  return fetch(NOTES_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date, note }) }).then((x) => x.json());
}
async function deleteNote(id: number) {
  return fetch(`${NOTES_URL}?id=${id}`, { method: "DELETE" }).then((x) => x.json());
}

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

  // Backdated notes (past PAST_WINDOW_DAYS days), lazily loaded when expanded.
  const today = bkkToday();
  const pastFrom = addDaysIso(today, -PAST_WINDOW_DAYS);
  const [pastOpen, setPastOpen] = useState(false);
  const [pastNotes, setPastNotes] = useState<EventNote[]>([]);
  const [pastLoading, setPastLoading] = useState(false);
  const [pastDate, setPastDate] = useState(today);
  const [pastDraft, setPastDraft] = useState("");

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
    fetch(`${NOTES_URL}?from=${from}&to=${to}`, { cache: "no-store" })
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

  useEffect(() => {
    if (!pastOpen) return;
    let alive = true; setPastLoading(true);
    fetch(`${NOTES_URL}?from=${pastFrom}&to=${today}`, { cache: "no-store" })
      .then((x) => x.json())
      .then((r) => { if (alive && r.ok) setPastNotes(r.notes as EventNote[]); })
      .catch(() => {})
      .finally(() => { if (alive) setPastLoading(false); });
    return () => { alive = false; };
  }, [pastOpen, pastFrom, today]);

  const addNote = async (date: string) => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true); setNoteErr(null);
    try {
      const r = await postNote(date, text);
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
      const r = await deleteNote(id);
      // ok, or 404 (a teammate already deleted it) → drop the stale pill either way.
      if (r.ok || r.error === "not_found") setNotesByDate((prev) => ({ ...prev, [date]: (prev[date] ?? []).filter((n) => n.id !== id) }));
      else setNoteErr(r.message ?? "ลบโน้ตไม่สำเร็จ");
    } catch { setNoteErr("ลบโน้ตไม่สำเร็จ"); }
    finally { setBusy(false); }
  };

  const addPastNote = async () => {
    const text = pastDraft.trim();
    if (!text || !pastDate || busy) return;
    setBusy(true); setNoteErr(null);
    try {
      const r = await postNote(pastDate, text);
      if (r.ok && r.note) { setPastNotes((prev) => [...prev, r.note]); setPastDraft(""); }
      else setNoteErr(r.message ?? "เพิ่มโน้ตไม่สำเร็จ");
    } catch { setNoteErr("เพิ่มโน้ตไม่สำเร็จ"); }
    finally { setBusy(false); }
  };

  const removePastNote = async (id: number) => {
    if (busy) return;
    setBusy(true); setNoteErr(null);
    try {
      const r = await deleteNote(id);
      if (r.ok || r.error === "not_found") setPastNotes((prev) => prev.filter((n) => n.id !== id));
      else setNoteErr(r.message ?? "ลบโน้ตไม่สำเร็จ");
    } catch { setNoteErr("ลบโน้ตไม่สำเร็จ"); }
    finally { setBusy(false); }
  };

  const pastGroups = Object.entries(
    pastNotes.reduce((acc, n) => { (acc[n.eventDate] ??= []).push(n); return acc; }, {} as Record<string, EventNote[]>)
  ).sort((a, b) => (a[0] < b[0] ? 1 : -1));   // newest date first

  // One pass over the days: peak (scales each card's bar), open-day count, total
  // predicted and the strongest day — for the plan summary (owner 2026-09-27).
  let maxPred = 0, totalPred = 0, openCount = 0;
  let strongest: BranchForecast["rows"][number] | null = null;
  if (fc) for (const r of fc.rows) {
    if (!r.closed && r.predictedNett != null) {
      openCount += 1; totalPred += r.predictedNett;
      if (r.predictedNett > maxPred) maxPred = r.predictedNett;
      if (strongest == null || r.predictedNett > (strongest.predictedNett ?? 0)) strongest = r;
    }
  }

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
          <button type="button" onClick={() => onSend(days)} disabled={!hasLineGroup || !fc?.hasBaseline || loading}
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
          {/* Plan summary (owner 2026-09-27): total predicted + strongest day at a glance. */}
          {openCount > 0 && (
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 flex flex-wrap gap-x-5 gap-y-1">
              <span>แผน {fc.days} วันนี้ · คาดยอดรวม <span className="font-bold text-emerald-700">~{baht(totalPred)}</span></span>
              {strongest && <span>วันแรงสุด <span className="font-semibold text-slate-800">{bigDate(strongest.date, strongest.dow)}</span> (~{baht(strongest.predictedNett ?? 0)})</span>}
            </div>
          )}
          {/* Horizontal swipe strip (owner 2026-09-27: "เอาเป็นสไลด์ข้าง") — one
              card per day, weather icon + high/low temp + rain, a magnitude bar
              for the predicted sales, holiday/suggestions and the note tagging. */}
          <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x snap-mandatory">
            {fc.rows.map((r) => {
              const dayNotes = notesByDate[r.date] ?? [];
              const icon = weatherIcon(r.weather);
              const wline = weatherLine(r.weather);
              const wsummary = r.weather && r.weather.summary !== "อากาศปกติ" ? r.weather.summary : null;
              const barPct = !r.closed && r.predictedNett != null && r.predictedNett > 0 && maxPred > 0 ? Math.max(6, Math.round((r.predictedNett / maxPred) * 100)) : 0;
              // The payday badge already states this, so drop the duplicate suggestion line.
              const shownSug = r.payday ? r.suggestions.filter((s) => !s.startsWith("ช่วงเงินเดือนออก")) : r.suggestions;
              return (
              <div key={r.date} className="snap-start shrink-0 w-52 rounded-2xl border border-slate-200/80 bg-white p-3.5 shadow-sm hover:shadow-md transition-shadow flex flex-col gap-2">
                <div className="flex items-start justify-between gap-1.5">
                  <div className="min-w-0">
                    <div className="text-[15px] font-bold text-slate-800">{bigDate(r.date, r.dow)}</div>
                    {(wsummary || wline) && <div className="text-[11px] text-slate-500 mt-0.5 truncate">{[wsummary, wline].filter(Boolean).join(" · ")}</div>}
                  </div>
                  {icon && <span className="shrink-0 text-xl leading-none" title={r.weather?.summary ?? undefined}>{icon}</span>}
                </div>
                <div>
                  {/* Match the page's KPI numbers (text-base font-bold) so this doesn't
                      read as an odd oversized/extrabold figure (owner 2026-09-27). */}
                  <div className={`text-base font-bold ${r.closed ? "text-rose-500" : "text-slate-900"}`}>{r.closed ? "ปิดทำการ" : (r.predictedNett != null ? `~${baht(r.predictedNett)}` : "—")}</div>
                  {barPct > 0 && (
                    <div className="mt-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                      <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-brand" style={{ width: `${barPct}%` }} />
                    </div>
                  )}
                </div>
                {(r.holiday || (r.payday && !r.closed && !fc.isClinic)) && (
                  <div className="flex flex-wrap gap-1">
                    {r.holiday && <span className="inline-flex items-center rounded-full bg-amber-50 text-amber-700 text-[10px] font-semibold px-2 py-0.5">🎌 {r.holiday}</span>}
                    {r.payday && !r.closed && !fc.isClinic && <span className="inline-flex items-center rounded-full bg-amber-50 text-amber-700 text-[10px] font-semibold px-2 py-0.5">เงินเดือนออก</span>}
                  </div>
                )}
                {shownSug.length > 0 && (
                  <ul className="space-y-0.5">
                    {shownSug.map((s, i) => (
                      <li key={i} className="flex gap-1 text-[11px] text-slate-600 leading-snug"><span className="text-brand">•</span><span>{s}</span></li>
                    ))}
                  </ul>
                )}
                {/* Team-tagged event notes for this day */}
                {dayNotes.length > 0 && (
                  <div className="flex flex-wrap gap-1">
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
                  <div className="flex flex-col gap-1 mt-auto">
                    <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={EVENT_NOTE_MAX}
                      onKeyDown={(e) => { if (e.key === "Enter") addNote(r.date); if (e.key === "Escape") { setOpenFor(null); setDraft(""); } }}
                      placeholder="เช่น มีงานวิ่งใกล้ร้าน / ถนนปิด"
                      className="w-full rounded-md border border-slate-200 px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-violet-300" />
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => addNote(r.date)} disabled={busy || !draft.trim()}
                        className="text-[12px] font-semibold text-violet-700 disabled:opacity-40">บันทึก</button>
                      <button type="button" onClick={() => { setOpenFor(null); setDraft(""); }}
                        className="text-[12px] text-slate-400 hover:text-slate-600">ยกเลิก</button>
                    </div>
                  </div>
                ) : (
                  <button type="button" onClick={() => { setOpenFor(r.date); setDraft(""); setNoteErr(null); }}
                    className="text-[11px] text-violet-600 hover:text-violet-800 text-left mt-auto">+ โน้ตเหตุการณ์</button>
                )}
              </div>
              );
            })}
          </div>
        </>
      )}

      {/* Backdated notes — tag past days too (owner 2026-09-27) */}
      <div className="border-t border-slate-100 pt-2">
        <button type="button" onClick={() => { setPastOpen((v) => !v); setNoteErr(null); }}
          className="text-[12px] font-semibold text-slate-600 hover:text-slate-800">
          {pastOpen ? "▾" : "▸"} 📌 โน้ตเหตุการณ์ย้อนหลัง
        </button>
        {pastOpen && (
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <input type="date" value={pastDate} max={today} min={pastFrom} onChange={(e) => setPastDate(e.target.value)}
                className="rounded-md border border-slate-200 px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-violet-300" />
              <input value={pastDraft} onChange={(e) => setPastDraft(e.target.value)} maxLength={EVENT_NOTE_MAX}
                onKeyDown={(e) => { if (e.key === "Enter") addPastNote(); }}
                placeholder="เช่น ฝนตกหนักทั้งวัน / ลูกค้ากลุ่มใหญ่มา / ไฟดับ"
                className="flex-1 min-w-[8rem] rounded-md border border-slate-200 px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-violet-300" />
              <button type="button" onClick={addPastNote} disabled={busy || !pastDraft.trim() || !pastDate}
                className="text-[12px] font-semibold text-violet-700 px-2 py-1 disabled:opacity-40">บันทึก</button>
            </div>
            {pastLoading ? (
              <p className="text-[11px] text-slate-400">กำลังโหลด…</p>
            ) : pastGroups.length === 0 ? (
              <p className="text-[11px] text-slate-400">ยังไม่มีโน้ตย้อนหลัง ({PAST_WINDOW_DAYS} วันล่าสุด)</p>
            ) : (
              <div className="space-y-1.5">
                {pastGroups.map(([date, ns]) => (
                  <div key={date}>
                    <div className="text-[11px] text-slate-500">{dateLabel(date)}</div>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {ns.map((n) => (
                        <span key={n.id} className="inline-flex items-center gap-1 rounded-full bg-violet-50 text-violet-700 text-[11px] px-2 py-0.5"
                          title={n.createdByName ? `แท็กโดย ${n.createdByName}` : undefined}>
                          📌 {n.note}
                          <button type="button" onClick={() => removePastNote(n.id)} disabled={busy}
                            className="text-violet-400 hover:text-rose-500 disabled:opacity-50" aria-label="ลบโน้ต">×</button>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
