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

/** Birthday marker rendered on each matching day of the calendar.
 *  Triggers a greeting modal so colleagues can fire off a quick
 *  "สุขสันต์วันเกิด" via the LINE OA. Birthdays roll over yearly
 *  (we match month-day, not full date) so a 2002-04-15 dob shows on
 *  April 15 every year. */
type BirthdayLite = {
  user_id: number;
  display_name: string;
  nickname_th: string | null;
  /** "MM-DD" — pre-extracted server-side so the client doesn't have
   *  to parse full dob strings (which also contain age, sensitive). */
  month_day: string;
  /** True when the matched person is the current viewer — gates the
   *  greeting modal so we don't show "send wishes to yourself". */
  is_self: boolean;
};

export default function RosterCalendarView({
  month,
  daysInMonth,
  positions,
  assignments,
  birthdays,
  currentUserId,
  dayDetailAllAssignments,
  selfFocusMode = false,
  holidayMap = {}
}: {
  month: string;             // YYYY-MM
  daysInMonth: number;
  positions: PositionLite[];
  assignments: AssignmentRow[];
  /** Optional — empty array hides the birthday layer entirely. */
  birthdays?: BirthdayLite[];
  /** For "don't show greet-yourself button" gate. Required only when
   *  birthdays are passed. */
  currentUserId?: number;
  /** Optional second assignment set (2026-05-31). When passed, the
   *  expanded-day panel reveals a "ดูเพื่อนร่วมงานในวันนี้" toggle
   *  that pulls in rows from this superset. Staff calendars pass
   *  their own shifts as `assignments` (rendered in cells) AND the
   *  whole branch roster here (lazy-revealed). Admin pages leave
   *  this undefined so the toggle never appears. */
  dayDetailAllAssignments?: AssignmentRow[];
  /** Tells the renderer "this is staff-focused — show OFF on empty
   *  days, headline copy implies single-person view". Cosmetic only;
   *  data filtering is the caller's job. */
  selfFocusMode?: boolean;
  /** วันหยุดประเพณีของเดือน — "YYYY-MM-DD" -> ชื่อ. ไฮไลต์ cell ให้เห็นชัด
   *  (แสดงผลอย่างเดียว). ไม่ส่ง = ไม่แสดง (backward-compatible กับ caller เดิม). */
  holidayMap?: Record<string, string>;
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

  // Colleague-reveal state (staff calendar). When false, the day
  // panel only shows the staff's own shifts (from `assignments`).
  // Toggling reveals the colleague rows from
  // `dayDetailAllAssignments` for the SAME date. Resets when the
  // user moves to a different day.
  const [showColleagues, setShowColleagues] = useState(false);
  function openDayPanel(date: string): void {
    setShowColleagues(false);
    setOpenDate((d) => (d === date ? null : date));
  }

  // Map ALL assignments by date for the colleague reveal. Only
  // computed when the prop is passed (admin pages leave it
  // undefined; this then short-circuits to an empty map).
  const allByDate = useMemo(() => {
    const m = new Map<string, AssignmentRow[]>();
    for (const a of dayDetailAllAssignments ?? []) {
      const arr = m.get(a.date);
      if (arr) arr.push(a);
      else m.set(a.date, [a]);
    }
    return m;
  }, [dayDetailAllAssignments]);

  // Group birthdays by MM-DD so we can render a icon on each
  // matching cell. People with the same dob land in the same bucket
  // (rare but possible — 2 staff sharing 5 January, etc.).
  const birthdaysByMonthDay = useMemo(() => {
    const m = new Map<string, BirthdayLite[]>();
    for (const b of birthdays ?? []) {
      const arr = m.get(b.month_day);
      if (arr) arr.push(b);
      else m.set(b.month_day, [b]);
    }
    return m;
  }, [birthdays]);

  // Greeting modal state. null = closed; set to a birthday list to
  // open the picker. The modal then drives a POST to the LINE-OA
  // push endpoint.
  const [greetTarget, setGreetTarget] = useState<BirthdayLite | null>(null);
  const [greetMsg, setGreetMsg] = useState<string>("");
  const [greetBusy, setGreetBusy] = useState(false);
  const [greetStatus, setGreetStatus] = useState<string | null>(null);

  const GREET_PRESETS = [
    "สุขสันต์วันเกิดครับ! ขอให้สุขภาพแข็งแรง รวยๆ ปังๆ ทั้งปีนะครับ",
    "Happy Birthday! ขอให้สมหวังทุกเรื่องที่ตั้งใจไว้นะครับ",
    "สุขสันต์วันเกิดค่ะ! เป็นเพื่อนร่วมงานที่ดีตลอดมา ขอให้มีความสุขมากๆ นะคะ"
  ];

  async function sendGreeting(): Promise<void> {
    if (!greetTarget || !greetMsg.trim()) return;
    setGreetBusy(true);
    setGreetStatus(null);
    try {
      const res = await fetch("/api/persona/birthday/greet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to_user_id: greetTarget.user_id,
          message: greetMsg.trim()
        })
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setGreetStatus(j?.message || j?.error || "ส่งไม่สำเร็จ ลองอีกครั้ง");
        return;
      }
      setGreetStatus("✓ ส่งคำอวยพรแล้ว!");
      setTimeout(() => {
        setGreetTarget(null);
        setGreetMsg("");
        setGreetStatus(null);
      }, 1400);
    } catch {
      setGreetStatus("เครือข่ายมีปัญหา ลองอีกครั้ง");
    } finally {
      setGreetBusy(false);
    }
  }

  function openGreet(person: BirthdayLite): void {
    setGreetTarget(person);
    setGreetMsg(GREET_PRESETS[0]);
    setGreetStatus(null);
  }

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
          // Birthday lookup uses the cell's MM-DD; matches roll yearly.
          const dayBirthdays = birthdaysByMonthDay.get(cell.date.slice(5)) ?? [];
          // In self-focus mode (staff view), an empty cell IS the
          // staff's day off — show "OFF" subtly top-right so the
          // calendar reads at a glance, matching the iOS reference.
          const isOff = selfFocusMode && rows.length === 0;
          const holiday = holidayMap[cell.date];
          return (
            <button
              key={cell.date}
              type="button"
              title={holiday || undefined}
              onClick={() => openDayPanel(cell.date)}
              className={`min-h-[88px] text-left p-1.5 border-r border-b border-slate-100 transition relative
                ${holiday
                  ? "bg-amber-50 ring-1 ring-amber-300 ring-inset"
                  : rows.length === 0
                    ? (isOff ? "bg-slate-50/60" : "bg-white")
                    : "bg-rose-50/30"}
                ${isToday ? "ring-2 ring-brand ring-inset z-[1]" : ""}
                hover:bg-rose-50/60`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className={`text-[11px] font-bold ${
                  holiday ? "text-amber-700"
                  : isOff ? "text-slate-400"
                  : isWeekend ? "text-rose-500"
                  : "text-slate-700"
                }`}>
                  {cell.day}
                </span>
                <div className="flex items-center gap-1">
                  {isOff && (
                    <span className="text-[8px] uppercase tracking-wider font-bold text-slate-400">
                      OFF
                    </span>
                  )}
                  {dayBirthdays.length > 0 && (
                    <span className="text-[10px] text-amber-600" title={dayBirthdays.map(b => b.display_name).join(", ")}>
                      ★
                    </span>
                  )}
                  {rows.length > 0 && !selfFocusMode && (
                    <span className="text-[9px] font-bold text-slate-400">
                      {rows.length}
                    </span>
                  )}
                </div>
              </div>
              {holiday && (
                <div className="text-[8px] leading-tight font-bold text-amber-700 truncate mb-0.5" title={holiday}>
                  {holiday}
                </div>
              )}
              <div className="space-y-0.5">
                {visible.map((a) => (
                  <div
                    key={a.id}
                    className="text-[10px] leading-tight truncate flex items-center gap-1"
                    title={`${a.user_display_name} · ${positionTitleById.get(a.position_id) ?? ""} · ${a.shift_code}`}
                  >
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{ background: a.shift_color || "#a06820" }}
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
      {openDate && (
        // Panel renders when ANY of these is true:
        //   - the day has own shifts to show
        //   - it's a birthday match
        //   - it's an OFF day in self-focus mode (so the user can
        //     still tap to see "you're off · or see colleagues")
        byDate.get(openDate)
        || (birthdaysByMonthDay.get(openDate.slice(5))?.length ?? 0) > 0
        || (selfFocusMode && dayDetailAllAssignments)
      ) && (
        <div className="border-t-2 border-brand bg-rose-50/30 p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-bold text-slate-800">
              วันที่ {openDate}
              {selfFocusMode
                ? ((byDate.get(openDate)?.length ?? 0) > 0 ? " · เข้างาน" : " · วันหยุด")
                : ` (${byDate.get(openDate)?.length ?? 0} กะ)`}
            </h3>
            <button
              type="button"
              onClick={() => setOpenDate(null)}
              className="text-slate-400 hover:text-slate-600 text-lg leading-none"
              aria-label="ปิด"
            >×</button>
          </div>

          {/* Birthday section — only when there's at least one match
              on the selected day. Each non-self entry gets a "ส่งคำ
              อวยพร" button that opens the greeting modal. */}
          {(() => {
            const todayBdays = birthdaysByMonthDay.get(openDate.slice(5)) ?? [];
            if (todayBdays.length === 0) return null;
            return (
              <div className="mb-3 space-y-1.5">
                {todayBdays.map((b) => {
                  const isMe = currentUserId != null && b.user_id === currentUserId;
                  return (
                    <div
                      key={b.user_id}
                      className="flex items-center gap-2 text-xs bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5"
                    >
                      <span className="font-bold text-slate-800 flex-1 truncate">
                        วันเกิด {b.nickname_th?.trim() || b.display_name}
                      </span>
                      {isMe ? (
                        <span className="text-[10px] text-slate-500 font-medium">วันเกิดคุณ</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => openGreet(b)}
                          className="text-[10px] px-2 py-1 rounded-md bg-brand text-white font-bold hover:bg-brand/90"
                        >
                          ส่งคำอวยพร
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {/* Own shifts for the day. In self-focus mode this is just
              the user's own row(s). When the day has NO own shift
              but the user opened the panel anyway (e.g. tapped an
              OFF cell), show a quiet "วันหยุด" line + still allow
              the colleague-toggle to reveal who's working. */}
          {(byDate.get(openDate) ?? []).length > 0 ? (
            <div className="space-y-1.5">
              {(byDate.get(openDate) ?? []).map((a) => (
                <div
                  key={a.id}
                  className="flex items-center gap-2 text-xs bg-white rounded-md px-2.5 py-1.5 border border-slate-200"
                >
                  <span
                    className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                    style={{ background: a.shift_color || "#a06820" }}
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
          ) : selfFocusMode ? (
            <div className="text-xs text-slate-500 italic py-2">
              วันนี้คุณไม่ได้เข้างาน
            </div>
          ) : null}

          {/* Colleague reveal (staff calendar). Shown only when
              dayDetailAllAssignments is passed AND there are
              colleagues on this day beyond the user's own shift. */}
          {dayDetailAllAssignments && (() => {
            const ownIds = new Set((byDate.get(openDate) ?? []).map((a) => a.id));
            const allDayRows = allByDate.get(openDate) ?? [];
            const colleagues = allDayRows.filter((a) => !ownIds.has(a.id));
            if (colleagues.length === 0) return null;
            return (
              <div className="mt-3 pt-3 border-t border-slate-200">
                {!showColleagues ? (
                  <button
                    type="button"
                    onClick={() => setShowColleagues(true)}
                    className="w-full text-xs py-2 rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50 font-medium"
                  >
                    ดูเพื่อนร่วมงานในวันนี้ ({colleagues.length} คน) ▼
                  </button>
                ) : (
                  <>
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-[10px] uppercase tracking-wider font-bold text-slate-500">
                        เพื่อนร่วมงานในวันนี้ ({colleagues.length})
                      </h4>
                      <button
                        type="button"
                        onClick={() => setShowColleagues(false)}
                        className="text-[10px] text-slate-400 hover:text-slate-600"
                      >
                        ซ่อน ▲
                      </button>
                    </div>
                    <div className="space-y-1.5">
                      {colleagues.map((a) => (
                        <div
                          key={a.id}
                          className="flex items-center gap-2 text-xs bg-slate-50 rounded-md px-2.5 py-1.5"
                        >
                          <span
                            className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                            style={{ background: a.shift_color || "#94a3b8" }}
                          />
                          <span className="font-medium text-slate-700 flex-1 truncate">
                            {a.user_display_name}
                          </span>
                          <span className="text-slate-500 text-[10px]">
                            {positionTitleById.get(a.position_id) ?? ""}
                          </span>
                          <span className="font-mono text-[10px] bg-white px-1.5 py-0.5 rounded">
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
                  </>
                )}
              </div>
            );
          })()}
        </div>
      )}

      <div className="px-4 py-2 border-t border-slate-200 bg-slate-50/50 text-[10px] text-slate-500">
        {selfFocusMode
          ? "ช่อง OFF = วันหยุด · คลิกวันเพื่อดูรายละเอียด + เพื่อนร่วมงาน"
          : "คลิกที่ช่องวันเพื่อดูรายละเอียดทั้งหมด"}
        {(birthdays?.length ?? 0) > 0 && " · = วันเกิดเพื่อนร่วมงาน คลิกเพื่อส่งคำอวยพร"}
      </div>

      {/* Birthday greeting modal. Renders only when greetTarget is set
          (= someone tapped "ส่งคำอวยพร" on a non-self birthday entry).
          Modal lets the user pick a preset or write a custom message,
          then fires POST /api/persona/birthday/greet which routes the
          push through the platform OA to the target's LINE userId. */}
      {greetTarget && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget && !greetBusy) setGreetTarget(null); }}
        >
          <div
            className="bg-white rounded-2xl max-w-md w-full p-5 space-y-3 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-bold text-slate-800">
                  ส่งคำอวยพรวันเกิดให้
                </h3>
                <p className="text-base font-bold text-brand truncate">
                  {greetTarget.nickname_th?.trim() || greetTarget.display_name}
                </p>
              </div>
              <button
                type="button"
                onClick={() => !greetBusy && setGreetTarget(null)}
                disabled={greetBusy}
                className="text-slate-400 hover:text-slate-600 text-xl leading-none disabled:opacity-30"
                aria-label="ปิด"
              >×</button>
            </div>

            <div>
              <label className="text-[10px] uppercase tracking-wider font-bold text-slate-500">
                เลือกแบบสำเร็จรูป
              </label>
              <div className="grid grid-cols-1 gap-1.5 mt-1">
                {GREET_PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setGreetMsg(p)}
                    className={`text-left text-xs p-2 rounded-md border transition ${
                      greetMsg === p
                        ? "border-brand bg-rose-50/40 text-slate-800"
                        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-[10px] uppercase tracking-wider font-bold text-slate-500">
                ข้อความ (แก้ไขได้)
              </label>
              <textarea
                className="input text-sm mt-1"
                rows={4}
                maxLength={500}
                value={greetMsg}
                onChange={(e) => setGreetMsg(e.target.value)}
                placeholder="พิมพ์คำอวยพรเอง..."
              />
              <p className="text-[10px] text-slate-400 text-right">
                {greetMsg.length} / 500
              </p>
            </div>

            {greetStatus && (
              <div className={`text-xs rounded-md p-2 ${
                greetStatus.startsWith("✓")
                  ? "bg-emerald-50 border border-emerald-200 text-emerald-700"
                  : "bg-rose-50 border border-rose-200 text-rose-700"
              }`}>
                {greetStatus}
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => setGreetTarget(null)}
                disabled={greetBusy}
                className="flex-1 btn-secondary text-sm"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={sendGreeting}
                disabled={greetBusy || !greetMsg.trim()}
                className="flex-1 btn-primary text-sm disabled:opacity-50"
              >
                {greetBusy ? "กำลังส่ง..." : "ส่งคำอวยพร"}
              </button>
            </div>

            <p className="text-[10px] text-slate-400 leading-snug">
              ข้อความจะถูกส่งผ่าน IKIGAI OS LINE OA ตรงไปยังพนักงานคนนี้
              · จะไม่ส่งถ้าผู้รับยังไม่ได้เชื่อมต่อ LINE
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
