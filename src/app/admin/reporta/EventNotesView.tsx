"use client";

// Team-tagged event notes on a daily/weekly report (owner 2026-09-27: "ให้โน้ต
// ย้อนหลังไปโผล่ในรายงานรายวัน/สัปดาห์ด้วย"). Shared by the restaurant daily/weekly
// cards + previews and the clinic weekly card so the violet notes block never
// drifts. Daily passes one group (no label, may be empty → nothing renders);
// weekly passes one group per day (each with a date label).

export type EventNotesGroup = { dateLabel?: string; notes: string[] };

export default function EventNotesView({ days }: { days: EventNotesGroup[] }) {
  // Daily may hand us a single empty group, so filter here (weekly's source
  // already drops empty days).
  const groups = days.filter((d) => d.notes.length);
  if (!groups.length) return null;
  return (
    <div className="rounded-lg bg-violet-50 border border-violet-100 p-2 my-1 space-y-1">
      <div className="text-[11px] font-bold text-violet-700">📌 โน้ตเหตุการณ์จากทีม</div>
      {groups.map((g, i) => (
        <div key={g.dateLabel ?? `g${i}`}>
          {g.dateLabel && <div className="text-[10px] text-violet-500">{g.dateLabel}</div>}
          {g.notes.map((n, j) => <div key={`${g.dateLabel ?? ""}:${j}:${n}`} className="text-[11px] text-violet-800 leading-snug">• {n}</div>)}
        </div>
      ))}
    </div>
  );
}
