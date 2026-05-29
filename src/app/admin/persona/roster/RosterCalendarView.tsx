"use client";

// Roster — Calendar (month) view.
//
// Alternative read-only render of the same assignments[] that the
// grid view (RosterClient) shows. Lets the admin see "who's working
// what on each calendar day" at a glance — useful when planning
// around holidays or stacking shifts, where the position-by-day
// grid is the wrong axis.
//
// Layout:
//   • 7 columns (อา จ อ พ พฤ ศ ส)
//   • Rows = weeks of the selected month (5–6 rows depending on
//     month start day)
//   • Each cell:
//       - Day number top-left
//       - Up to 4 assignment chips: "ชื่อเล่น/displayName · CODE"
//       - "+N more" pill if overflow
//       - Today's cell has a brand-coloured ring
//
// Click a cell → tap-to-expand list (mobile) / hover-reveal (desktop)
// shows the full assignment list without leaving the page. We do NOT
// surface assign/clear actions here — switch to grid view for that.
// Editing in a calendar would compound the modal complexity and
// duplicate state with RosterClient; the toggle at the top is one
// click away.

import { useMemo, useState } from "react";

type AssignmentRow = {
  id: number;
  date: string;             // YYYY-MM-DD
  position_id: number;
  user_id: number;
  user_display_name: string;
  user_first_name: string | null;
  user_last_name: string | null;
  shift_code_id: number;
  shift_code: string;
  shift_color: string | null;
  shift_start_time: string | null;
};

type PositionLite = { id: number; title: string };

export default function RosterCalendarView({
  month,
  daysInMonth,
  positions,
  assignments
}: {
  month: string;             // YYYY-MM
  daysInMonth: number;
  positions: PositionLite[];
  assignments: AssignmentRow[];
}) {
  const [yyyy, mm] = month.split("-").map(Number);
  // JS Date getDay(): 0 = Sunday, 6 = Saturday. Bangkok week starts
  // on Sunday by Thai convention.
  const firstDow = new Date(Date.UTC(yyyy, mm - 1, 1)).getUTCDay();
  // Today (Bangkok) for the highlight ring.
  const nowBkk = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const todayStr = nowBkk.toISOString().slice(0, 10);

  // Group assignments by date once. listAssignmentsForMonth orders
  // rows in a deterministic stable order, so the chips inside each
  // cell appear in a consistent sequence across days.
  const byDate = useMemo(() => {
    const m = new Map<string, AssignmentRow[]>();
    for (const a of assignments) {
      const arr = m.get(a.date);
      if (arr) arr.push(a);
      else m.set(a.date, [a]);
    }
    return m;
  }, [assignments]);

  // Build flat array of cells: leading blanks, then days 1..N,
  // chunked into rows of 7 for render. Trailing blanks added so the
  // last row is always full (avoids the visual stutter of a 2-cell
  // last row).
  const cells: Array<{ day: number; date: string } | null> = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${month}-${String(d).padStart(2, "0")}`;
    cells.push({ day: d, date });
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const positionTitleById = new Map(positions.map((p) => [p.id, p.title]));

  // Selected day for the expand-on-tap detail panel (mobile-first).
  // Desktop also benefits — eight chips per cell is too many to fit
  // when a Saturday has full coverage.
  const [openDate, setOpenDate] = useState<string | null>(null);

  function shortName(a: AssignmentRow): string {
    // Prefer first_name_th when present (more recognisable in Thai
    // restaurant rosters than display_name which is often the full
    // legal name). Fall back to display_name's first token.
    if (a.user_first_name && a.user_first_name.trim()) return a.user_first_name.trim();
    const first = a.user_display_name.split(/\s+/)[0];
    return first || a.user_display_name;
  }

  const weekHeaders = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];
  const MAX_CHIPS_PER_CELL = 4;

  return (
    <div className="card overflow-hidden p-0">
      {/* Day-of-week header */}
      <div className="grid grid-cols-7 bg-slate-100 border-b border-slate-200">
        {weekHeaders.map((w, i) => (
          <div
            key={w}
            className={`text-center text-[10px] font-bold py-1.5 ${
              i === 0 || i === 6 ? "text-rose-500" : "text-slate-600"
            }`}
          >
            {w}
          </div>
        ))}
      </div>

      {/* Calendar cells */}
      <div className="grid grid-cols-7">
        {cells.map((cell, i) => {
          if (!cell) {
            return <div key={`b-${i}`} className="bg-slate-50/50 min-h-[88px] border-r border-b border-slate-100" />;
          }
          const rows = byDate.get(cell.date) ?? [];
          const isToday = cell.date === todayStr;
          const dow = (i % 7);
          const isWeekend = dow === 0 || dow === 6;
          const overflow = rows.length - MAX_CHIPS_PER_CELL;
          const visible = rows.slice(0, MAX_CHIPS_PER_CELL);
          return (
            <button
              key={cell.date}
              type="button"
              onClick={() => setOpenDate((d) => (d === cell.date ? null : cell.date))}
              className={`min-h-[88px] text-left p-1.5 border-r border-b border-slate-100 transition relative
                ${rows.length === 0 ? "bg-white" : "bg-rose-50/30"}
                ${isToday ? "ring-2 ring-brand ring-inset z-[1]" : ""}
                hover:bg-rose-50/60`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className={`text-[11px] font-bold ${
                  isWeekend ? "text-rose-500" : "text-slate-700"
                }`}>
                  {cell.day}
                </span>
                {rows.length > 0 && (
                  <span className="text-[9px] font-bold text-slate-400">
                    {rows.length}
                  </span>
                )}
              </div>
              <div className="space-y-0.5">
                {visible.map((a) => (
                  <div
                    key={a.id}
                    className="text-[10px] leading-tight truncate flex items-center gap-1"
                    title={`${a.user_display_name} · ${positionTitleById.get(a.position_id) ?? ""} · ${a.shift_code}`}
                  >
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{ background: a.shift_color || "#e94560" }}
                    />
                    <span className="font-medium text-slate-800 truncate">
                      {shortName(a)}
                    </span>
                    <span className="text-slate-500 flex-shrink-0">·</span>
                    <span className="text-slate-500 font-mono text-[9px] flex-shrink-0">
                      {a.shift_code}
                    </span>
                  </div>
                ))}
                {overflow > 0 && (
                  <div className="text-[9px] text-brand font-bold">
                    +{overflow}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Expanded panel for the selected day. Shown below the grid so
          it doesn't disrupt the calendar layout. Mobile users can
          scroll a tiny bit; desktop users see it inline. */}
      {openDate && byDate.get(openDate) && (
        <div className="border-t-2 border-brand bg-rose-50/30 p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-bold text-slate-800">
              วันที่ {openDate} ({byDate.get(openDate)?.length ?? 0} กะ)
            </h3>
            <button
              type="button"
              onClick={() => setOpenDate(null)}
              className="text-slate-400 hover:text-slate-600 text-lg leading-none"
              aria-label="ปิด"
            >×</button>
          </div>
          <div className="space-y-1.5">
            {byDate.get(openDate)!.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-2 text-xs bg-white rounded-md px-2.5 py-1.5 border border-slate-200"
              >
                <span
                  className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                  style={{ background: a.shift_color || "#e94560" }}
                />
                <span className="font-medium text-slate-800 flex-1 truncate">
                  {a.user_display_name}
                </span>
                <span className="text-slate-500 text-[10px]">
                  {positionTitleById.get(a.position_id) ?? ""}
                </span>
                <span className="font-mono text-[10px] bg-slate-100 px-1.5 py-0.5 rounded">
                  {a.shift_code}
                </span>
                {a.shift_start_time && (
                  <span className="text-[10px] text-slate-500 font-mono">
                    {a.shift_start_time}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="px-4 py-2 border-t border-slate-200 bg-slate-50/50 text-[10px] text-slate-500">
        คลิกที่ช่องวันเพื่อดูรายละเอียดทั้งหมด · แก้ไขกะให้สลับไปใช้
        &quot;มุมมองตาราง&quot; ด้านบน
      </div>
    </div>
  );
}
