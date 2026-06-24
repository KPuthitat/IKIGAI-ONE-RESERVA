"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import { nameWithPrefix } from "@/lib/name";

// Roster monthly grid — admin clicks a cell to assign (or clear) a
// staff/shift combo. Renders the full month in one HTML table; CSS
// `position: sticky` keeps the left position column visible when the
// table scrolls horizontally.

type Position = { id: number; title: string; description: string | null };
type ShiftCode = {
  id: number; code: string; name: string | null;
  start_time: string; end_time: string; color: string | null;
};
type Staff = {
  id: number;
  display_name: string;
  title_prefix: string | null;
  first_name_th: string | null;
  last_name_th: string | null;
  employment_type: string | null;
};
type Assignment = {
  id: number;
  date: string;
  position_id: number;
  user_id: number;
  user_display_name: string;
  user_first_name: string | null;
  user_last_name: string | null;
  shift_code_id: number;
  shift_code: string;
  shift_color: string | null;
  shift_start_time: string;
};

const DOW_TH = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];

// Approved-leave type → short Thai label for the roster badge.
const LEAVE_LABEL_TH: Record<string, string> = {
  sick: "ลาป่วย", personal: "ลากิจ", annual: "ลาพักร้อน", pt_emergency: "ลาฉุกเฉิน",
  maternity: "ลาคลอด", ordination: "ลาบวช", sterilization: "ลาทำหมัน", military: "ลาทหาร"
};
const leaveLabel = (type: string | undefined): string => (type ? LEAVE_LABEL_TH[type] ?? "ลา" : "");

// Best-effort first/last split for a roster cell. Prefers the explicit
// users.first_name_th / last_name_th columns; falls back to splitting
// display_name on whitespace (stripping common Thai/English title
// prefixes first) so the 3-line cell layout still works even when
// admin hasn't filled the structured name fields for that employee.
function splitName(
  displayName: string,
  first: string | null,
  last: string | null
): { first: string; last: string } {
  const f = first?.trim() ?? "";
  const l = last?.trim() ?? "";
  if (f || l) return { first: f, last: l };
  const trimmed = (displayName ?? "").trim();
  if (!trimmed) return { first: "", last: "" };
  const stripped = trimmed.replace(
    /^(นาย|นาง|นางสาว|ดร\.|เด็กชาย|เด็กหญิง|Mr\.|Mrs\.|Ms\.|Dr\.)\s+/,
    ""
  );
  const parts = stripped.split(/\s+/);
  if (parts.length >= 2) {
    return {
      first: parts.slice(0, parts.length - 1).join(" "),
      last: parts[parts.length - 1]
    };
  }
  return { first: stripped, last: "" };
}

export default function RosterClient({
  month, daysInMonth, positions, shiftCodes, staff, assignments, leaveMap
}: {
  month: string;          // YYYY-MM
  daysInMonth: number;
  positions: Position[];
  shiftCodes: ShiftCode[];
  staff: Staff[];
  assignments: Assignment[];
  leaveMap: Record<string, string>;   // "${userId}:${date}" -> leave type
}) {
  const router = useRouter();
  const { t } = useLang();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<{ date: string; positionId: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishKind, setPublishKind] = useState<"publish" | "edit">("publish");
  const [publishNote, setPublishNote] = useState("");

  // 2026-05-31: focus-employee filter. Owner request — when admin is
  // tracking "who got scheduled when", the noise of 13 other names
  // is overwhelming. Picking one staff dims every other cell (and
  // the bottom totals row) so the admin sees just that person's
  // pattern across the month. Stored as numeric user id once picked;
  // typed text uses fuzzy match against display_name to populate the
  // suggestion list, then click commits to focusUserId.
  const [focusQuery, setFocusQuery] = useState("");
  const [focusUserId, setFocusUserId] = useState<number | null>(null);

  // Position visibility is configured server-side on
  // /admin/persona/roster/positions (per-position active toggle), so
  // there's no per-user filter chip here anymore. listPositions on
  // the page server already returns active=1 only — the grid just
  // renders whatever it gets.
  const visiblePositions = positions;

  // Build the full date list for the month so empty cells render too.
  const dates = useMemo(() => {
    const out: string[] = [];
    for (let d = 1; d <= daysInMonth; d++) {
      out.push(`${month}-${String(d).padStart(2, "0")}`);
    }
    return out;
  }, [month, daysInMonth]);

  // Lookup: { date: { positionId: Assignment } }
  const byCell = useMemo(() => {
    const m = new Map<string, Map<number, Assignment>>();
    for (const a of assignments) {
      if (!m.has(a.date)) m.set(a.date, new Map());
      m.get(a.date)!.set(a.position_id, a);
    }
    return m;
  }, [assignments]);

  // Right-column totals: count assignments per position.
  const positionTotals = useMemo(() => {
    const m = new Map<number, number>();
    for (const a of assignments) m.set(a.position_id, (m.get(a.position_id) ?? 0) + 1);
    return m;
  }, [assignments]);

  // Bottom-row totals: unique staff working each day.
  const dailyTotals = useMemo(() => {
    const m = new Map<string, Set<number>>();
    for (const a of assignments) {
      if (!m.has(a.date)) m.set(a.date, new Set());
      m.get(a.date)!.add(a.user_id);
    }
    const out = new Map<string, number>();
    for (const [date, set] of m) out.set(date, set.size);
    return out;
  }, [assignments]);

  // Per-staff totals (legend at the bottom): how many shifts each
  // staff member is on this month. Mirrors the spreadsheet's
  // right-edge column. Sorted by total desc, then by name.
  const staffTotals = useMemo(() => {
    const counts = new Map<number, number>();
    for (const a of assignments) counts.set(a.user_id, (counts.get(a.user_id) ?? 0) + 1);
    const rows = staff.map((s) => ({
      id: s.id, name: s.display_name, count: counts.get(s.id) ?? 0
    }));
    return rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [assignments, staff]);

  function refresh() {
    startTransition(() => router.refresh());
  }

  async function saveAssignment(args: {
    date: string; positionId: number;
    userId: number; shiftCodeId: number;
  }) {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/roster/assignment"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: args.date,
          position_id: args.positionId,
          user_id: args.userId,
          shift_code_id: args.shiftCodeId
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(j.error ?? t("common.error")); return; }
      setEditing(null);
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function clearCell(args: { date: string; positionId: number }) {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/roster/assignment"), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: args.date, position_id: args.positionId })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(j.error ?? t("common.error")); return; }
      setEditing(null);
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/roster/publish"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          year_month: month,
          kind: publishKind,
          note: publishNote.trim() || undefined
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(j.error ?? t("common.error")); return; }
      setPublishOpen(false);
      setPublishNote("");
      refresh();
    } finally {
      setBusy(false);
    }
  }

  // Day-of-week for a YYYY-MM-DD calendar date — uses Z (UTC midnight)
  // so `getUTCDay()` reflects the calendar date itself, not whatever
  // UTC day Bangkok-midnight happens to land on. The previous +07:00
  // form rendered every roster column off-by-one.
  const dowOf = (yyyymmdd: string) => {
    const d = new Date(`${yyyymmdd}T00:00:00Z`);
    return d.getUTCDay();
  };

  // Focus filter — fuzzy match against display_name. Only shown when
  // admin is typing (focusQuery non-empty) AND no explicit user
  // pinned yet. Picking from the dropdown sets focusUserId and clears
  // the query so the input collapses back to "พนักงานที่มุ่งเน้น" mode.
  const focusSuggestions = useMemo(() => {
    const q = focusQuery.trim().toLowerCase();
    if (!q || focusUserId != null) return [];
    return staff
      .filter((s) => {
        const hay = [s.display_name, s.first_name_th, s.last_name_th]
          .filter(Boolean).join(" ").toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 8);
  }, [focusQuery, focusUserId, staff]);

  const focusedStaff = useMemo(() =>
    focusUserId != null ? staff.find((s) => s.id === focusUserId) ?? null : null,
    [focusUserId, staff]
  );
  const focusedShiftDates = useMemo(() => {
    if (focusUserId == null) return new Set<string>();
    return new Set(
      assignments.filter((a) => a.user_id === focusUserId).map((a) => a.date)
    );
  }, [focusUserId, assignments]);

  function clearFocus() {
    setFocusUserId(null);
    setFocusQuery("");
  }
  function pickFocus(userId: number) {
    setFocusUserId(userId);
    setFocusQuery("");
  }

  /** True when the cell should look "in focus" — i.e. either no
   *  focus active, or the assignment matches the focused user. */
  function inFocus(a: Assignment | undefined): boolean {
    if (focusUserId == null) return true;
    return !!a && a.user_id === focusUserId;
  }

  return (
    <>
      {/* Focus-employee bar — type a name, dim everyone else. */}
      <div className="card relative space-y-2">
        {focusedStaff ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-slate-500">มุ่งเน้นที่:</span>
            <span className="text-sm font-bold bg-amber-100 text-amber-900 px-3 py-1 rounded-md">
              {nameWithPrefix(focusedStaff.title_prefix, focusedStaff.display_name)}
            </span>
            <span className="text-xs text-slate-500">
              ลงตารางไปแล้ว <b className="text-slate-800">{focusedShiftDates.size}</b> วันในเดือนนี้
              <span className="ml-1 text-slate-400">
                · พนักงานคนอื่นจางลงเพื่อให้สแกนง่าย
              </span>
            </span>
            <button type="button" onClick={clearFocus}
              className="ml-auto text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-50">
              ✕ ล้างการมุ่งเน้น
            </button>
          </div>
        ) : (
          <div className="space-y-1">
            <label className="label !mb-1">
              🔍 ค้นชื่อพนักงาน เพื่อมุ่งเน้นเฉพาะคนนี้
            </label>
            <input className="input"
              value={focusQuery}
              onChange={(e) => setFocusQuery(e.target.value)}
              placeholder="พิมพ์ชื่อ เช่น นาย ก." />
            {focusSuggestions.length > 0 && (
              <div className="absolute z-20 mt-1 max-h-60 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg w-full left-0 sm:max-w-md">
                {focusSuggestions.map((s) => (
                  <button key={s.id} type="button"
                    onClick={() => pickFocus(s.id)}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-amber-50 border-b border-slate-100 last:border-0">
                    <div className="font-bold text-slate-800">{nameWithPrefix(s.title_prefix, s.display_name)}</div>
                    {(s.first_name_th || s.last_name_th) && (
                      <div className="text-[11px] text-slate-500">
                        {[s.first_name_th, s.last_name_th].filter(Boolean).join(" ")}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
            <p className="text-[11px] text-slate-400">
              เลือกเพื่อให้ระบบจางชื่อพนักงานคนอื่นในตาราง — สแกนวันลงเวรของคนเดียวง่ายขึ้น
            </p>
          </div>
        )}
      </div>

      <div className="card overflow-x-auto">
        <table className="text-xs border-collapse min-w-full">
          <thead>
            <tr className="bg-slate-100">
              <th className="sticky left-0 z-10 bg-slate-100 text-left p-2 border border-slate-200 min-w-[140px]">
                {t("admin.persona.roster.col.position")}
              </th>
              {dates.map((d) => {
                const day = d.slice(8);
                const dow = dowOf(d);
                const isWeekend = dow === 0 || dow === 6;
                return (
                  <th key={d}
                    className={`p-1 border border-slate-200 min-w-[70px] text-center font-medium ${
                      isWeekend ? "bg-rose-50 text-rose-700" : ""
                    }`}>
                    <div className="text-[10px] text-slate-500">{DOW_TH[dow]}</div>
                    <div className="text-sm font-bold">{Number(day)}</div>
                  </th>
                );
              })}
              <th className="sticky right-0 z-10 bg-slate-100 p-2 border border-slate-200 text-right min-w-[60px]">
                {t("admin.persona.roster.col.total")}
              </th>
            </tr>
          </thead>
          <tbody>
            {visiblePositions.map((p) => (
              <tr key={p.id}>
                <td className="sticky left-0 z-10 bg-white border border-slate-200 p-2 align-top">
                  <div className="font-bold text-slate-800">{p.title}</div>
                  {p.description && (
                    <div className="text-[10px] text-slate-500 mt-0.5 line-clamp-2">
                      {p.description}
                    </div>
                  )}
                </td>
                {dates.map((d) => {
                  const a = byCell.get(d)?.get(p.id);
                  const focused = inFocus(a);
                  const onLeave = a ? leaveMap[`${a.user_id}:${d}`] : undefined;
                  return (
                    <td key={d}
                      className={`border border-slate-200 p-0 align-middle transition-opacity ${
                        focusUserId != null && !focused
                          ? "opacity-25 grayscale"
                          : ""
                      } ${
                        // Ring around cells the focused person actually
                        // owns — makes their pattern pop even more.
                        focusUserId != null && focused && a
                          ? "ring-2 ring-amber-400 ring-inset relative z-[1]"
                          : ""
                      }`}>
                      <button
                        type="button"
                        onClick={() => setEditing({ date: d, positionId: p.id })}
                        className={`w-full h-full min-h-[42px] px-1 py-1 text-[10px] hover:bg-slate-50 transition ${
                          a ? "" : "text-slate-300"
                        }`}
                        // On-leave cells get a rose wash so the slot reads as
                        // "needs a substitute" regardless of the shift colour.
                        style={onLeave ? { backgroundColor: "#fff1f2" } : (a?.shift_color ? { backgroundColor: a.shift_color } : undefined)}
                      >
                        {a ? (
                          <>
                            {/* Two-line layout: first name / shift.
                                Last name was intentionally dropped —
                                the cell is narrow and the schedule is
                                an internal view, so first name + role
                                + shift code is enough to identify
                                everyone without overflowing. */}
                            <div className={`font-bold leading-tight ${onLeave ? "text-slate-400 line-through" : "text-slate-800"}`}>
                              {splitName(a.user_display_name, a.user_first_name, a.user_last_name).first}
                            </div>
                            {onLeave ? (
                              <div className="text-[9px] font-bold text-rose-600 leading-tight mt-0.5">{leaveLabel(onLeave)}</div>
                            ) : (
                              <div className="text-[10px] text-slate-700 mt-0.5">
                                {a.shift_code}
                              </div>
                            )}
                          </>
                        ) : (
                          "+"
                        )}
                      </button>
                    </td>
                  );
                })}
                <td className="sticky right-0 z-10 bg-slate-50 border border-slate-200 p-2 text-right font-bold text-slate-700">
                  {positionTotals.get(p.id) ?? 0}
                </td>
              </tr>
            ))}
            {/* Bottom totals row — unique staff per day */}
            <tr className="bg-slate-100">
              <td className="sticky left-0 z-10 bg-slate-100 border border-slate-200 p-2 text-right font-bold text-slate-700">
                {t("admin.persona.roster.row.dailyTotal")}
              </td>
              {dates.map((d) => (
                <td key={d}
                  className="border border-slate-200 p-2 text-center font-bold text-slate-700">
                  {dailyTotals.get(d) ?? "—"}
                </td>
              ))}
              <td className="sticky right-0 z-10 bg-slate-100 border border-slate-200 p-2" />
            </tr>
          </tbody>
        </table>
      </div>

      {/* Shift code legend */}
      <div className="card">
        <h3 className="text-xs uppercase tracking-[0.5px] font-bold text-slate-500 mb-2">
          {t("admin.persona.roster.legend.shifts")}
        </h3>
        <div className="flex flex-wrap gap-2">
          {shiftCodes.map((s) => (
            <div key={s.id} className="flex items-center gap-1.5 text-xs">
              <span
                className="inline-block w-4 h-4 rounded border border-slate-300"
                style={{ backgroundColor: s.color ?? "#cbd5e1" }}
              />
              <span className="font-bold text-slate-800">{s.code}</span>
              <span className="text-slate-500">{s.start_time}–{s.end_time}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Staff totals legend — mirrors the spreadsheet's right-side
          "shifts assigned per person" summary. */}
      <div className="card">
        <h3 className="text-xs uppercase tracking-[0.5px] font-bold text-slate-500 mb-2">
          {t("admin.persona.roster.legend.staffTotals")}
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
          {staffTotals.map((s) => {
            const focused = focusUserId == null || s.id === focusUserId;
            return (
              <button key={s.id} type="button"
                onClick={() => focusUserId === s.id ? clearFocus() : pickFocus(s.id)}
                className={`text-sm flex justify-between border-b border-slate-100 pb-1 text-left transition ${
                  focused ? "" : "opacity-25"
                } ${
                  focusUserId === s.id
                    ? "bg-amber-50 -mx-1 px-1 rounded"
                    : "hover:bg-slate-50 -mx-1 px-1 rounded"
                }`}>
                <span className="text-slate-700 truncate">{s.name}</span>
                <span className="font-mono font-bold text-slate-800">{s.count}</span>
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-slate-400 mt-2">
          คลิกชื่อพนักงานเพื่อมุ่งเน้น/ล้างการมุ่งเน้น
        </p>
      </div>

      {/* Publish button */}
      <div className="card flex items-center gap-3 flex-wrap">
        <div className="flex-1">
          <h3 className="font-bold text-slate-800 text-sm">
            {t("admin.persona.roster.publish.title")}
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            {t("admin.persona.roster.publish.help")}
          </p>
        </div>
        <button type="button"
          onClick={() => { setPublishKind("publish"); setPublishOpen(true); }}
          className="text-sm px-4 py-2 rounded-lg bg-brand text-white font-bold hover:opacity-90">
          {t("admin.persona.roster.publish.publishBtn")}
        </button>
        <button type="button"
          onClick={() => { setPublishKind("edit"); setPublishOpen(true); }}
          className="text-sm px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">
          {t("admin.persona.roster.publish.editBtn")}
        </button>
      </div>

      {err && <div className="text-sm text-rose-600 text-center">✗ {err}</div>}

      {editing && (
        <AssignModal
          date={editing.date}
          positionId={editing.positionId}
          position={positions.find((p) => p.id === editing.positionId)!}
          existing={byCell.get(editing.date)?.get(editing.positionId) ?? null}
          shiftCodes={shiftCodes}
          staff={staff}
          leaveForDate={Object.fromEntries(
            staff.map((s) => [s.id, leaveMap[`${s.id}:${editing.date}`]]).filter(([, ty]) => ty)
          ) as Record<number, string>}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={saveAssignment}
          onClear={clearCell}
          t={t}
        />
      )}

      {publishOpen && (
        <PublishModal
          kind={publishKind}
          month={month}
          note={publishNote}
          onChangeNote={setPublishNote}
          onConfirm={publish}
          onCancel={() => { setPublishOpen(false); setPublishNote(""); }}
          busy={busy}
          t={t}
        />
      )}
    </>
  );
}

// ── Assign modal ─────────────────────────────────────────────────

function AssignModal({
  date, positionId, position, existing, shiftCodes, staff, leaveForDate, busy,
  onClose, onSave, onClear, t
}: {
  date: string; positionId: number;
  position: Position;
  existing: Assignment | null;
  shiftCodes: ShiftCode[];
  staff: Staff[];
  leaveForDate: Record<number, string>;   // userId -> leave type (for THIS date)
  busy: boolean;
  onClose: () => void;
  onSave: (a: { date: string; positionId: number; userId: number; shiftCodeId: number }) => void;
  onClear: (a: { date: string; positionId: number }) => void;
  t: (k: string, vars?: Record<string, string | number>) => string;
}) {
  // The current occupant is on leave this day → start with no staff picked so
  // the admin is nudged to choose a substitute (owner 2026-06-23).
  const existingOnLeave = existing ? leaveForDate[existing.user_id] : undefined;
  const [userId, setUserId] = useState<number | "">(existingOnLeave ? "" : (existing?.user_id ?? ""));
  const [shiftCodeId, setShiftCodeId] = useState<number | "">(existing?.shift_code_id ?? "");

  function submit() {
    if (!userId || !shiftCodeId) return;
    onSave({
      date, positionId,
      userId: Number(userId),
      shiftCodeId: Number(shiftCodeId)
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <div className="text-xs text-slate-500">{date}</div>
          <h3 className="font-bold text-slate-800 text-lg">{position.title}</h3>
          {position.description && (
            <p className="text-xs text-slate-500 mt-0.5">{position.description}</p>
          )}
        </div>
        {existingOnLeave && existing && (
          <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700">
            <b>{splitName(existing.user_display_name, existing.user_first_name, existing.user_last_name).first}</b> {leaveLabel(existingOnLeave)}วันนี้ — เลือกพนักงานคนอื่นมาทำแทน แล้วกดบันทึก (หรือกดลบเพื่อเว้นว่างไว้)
          </div>
        )}
        <div>
          <label className="label">{t("admin.persona.roster.modal.staff")}</label>
          <select className="input" value={userId}
            onChange={(e) => setUserId(e.target.value === "" ? "" : Number(e.target.value))}>
            <option value="">— {t("admin.persona.roster.modal.pickStaff")} —</option>
            {staff.map((s) => {
              const ty = leaveForDate[s.id];
              return (
                <option key={s.id} value={s.id} disabled={!!ty && s.id !== existing?.user_id}>
                  {nameWithPrefix(s.title_prefix, s.display_name)} {s.employment_type ? `(${s.employment_type.toUpperCase()})` : ""}{ty ? ` · ${leaveLabel(ty)}` : ""}
                </option>
              );
            })}
          </select>
        </div>
        <div>
          <label className="label">{t("admin.persona.roster.modal.shift")}</label>
          <div className="grid grid-cols-2 gap-2">
            {shiftCodes.map((s) => (
              <label key={s.id}
                className={`flex items-center gap-2 border rounded-lg p-2 cursor-pointer transition ${
                  shiftCodeId === s.id
                    ? "border-brand bg-rose-50/40 ring-1 ring-brand/30"
                    : "border-slate-200 hover:bg-slate-50"
                }`}>
                <input type="radio" name="shift" checked={shiftCodeId === s.id}
                  onChange={() => setShiftCodeId(s.id)} />
                <span
                  className="inline-block w-3 h-3 rounded border border-slate-300"
                  style={{ backgroundColor: s.color ?? "#cbd5e1" }}
                />
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-slate-800 text-sm">{s.code}</div>
                  <div className="text-[10px] text-slate-500">{s.start_time}–{s.end_time}</div>
                </div>
              </label>
            ))}
          </div>
        </div>
        <div className="flex gap-2 pt-1">
          {existing && (
            <button type="button" disabled={busy}
              onClick={() => onClear({ date, positionId })}
              className="px-3 py-2 rounded-lg border border-rose-200 text-rose-600 text-sm hover:bg-rose-50">
              {t("admin.persona.roster.modal.clear")}
            </button>
          )}
          <span className="flex-1" />
          <button type="button" onClick={onClose} disabled={busy}
            className="px-3 py-2 rounded-lg border border-slate-300 text-slate-700 text-sm">
            {t("common.cancel")}
          </button>
          <button type="button" onClick={submit}
            disabled={busy || !userId || !shiftCodeId}
            className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-bold disabled:opacity-50">
            {busy ? "…" : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Publish modal ────────────────────────────────────────────────

function PublishModal({
  kind, month, note, onChangeNote, onConfirm, onCancel, busy, t
}: {
  kind: "publish" | "edit";
  month: string;
  note: string;
  onChangeNote: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
  t: (k: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-slate-800">
          {kind === "publish"
            ? t("admin.persona.roster.publish.publishConfirmTitle")
            : t("admin.persona.roster.publish.editConfirmTitle")}
          <span className="ml-1 text-brand">· {month}</span>
        </h3>
        <p className="text-sm text-slate-600">
          {kind === "publish"
            ? t("admin.persona.roster.publish.publishConfirmBody")
            : t("admin.persona.roster.publish.editConfirmBody")}
        </p>
        <div>
          <label className="label">{t("admin.persona.roster.publish.notePrompt")}</label>
          <textarea className="input min-h-[80px]"
            placeholder={t("admin.persona.roster.publish.notePlaceholder")}
            value={note} onChange={(e) => onChangeNote(e.target.value)}
            maxLength={500} />
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} disabled={busy}
            className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 text-sm">
            {t("common.cancel")}
          </button>
          <button type="button" onClick={onConfirm} disabled={busy}
            className="flex-1 py-2.5 rounded-lg bg-brand text-white text-sm font-bold disabled:opacity-50">
            {busy ? t("common.submitting") : t("admin.persona.roster.publish.send")}
          </button>
        </div>
      </div>
    </div>
  );
}
