"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

// Roster monthly grid — admin clicks a cell to assign (or clear) a
// staff/shift combo. Renders the full month in one HTML table; CSS
// `position: sticky` keeps the left position column visible when the
// table scrolls horizontally.

type Position = { id: number; title: string; description: string | null };
type ShiftCode = {
  id: number; code: string; name: string | null;
  start_time: string; end_time: string; color: string | null;
};
type Staff = { id: number; display_name: string; employment_type: string | null };
type Assignment = {
  id: number;
  date: string;
  position_id: number;
  user_id: number;
  user_display_name: string;
  shift_code_id: number;
  shift_code: string;
  shift_color: string | null;
  shift_start_time: string;
};

const DOW_TH = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];

export default function RosterClient({
  month, daysInMonth, positions, shiftCodes, staff, assignments
}: {
  month: string;          // YYYY-MM
  daysInMonth: number;
  positions: Position[];
  shiftCodes: ShiftCode[];
  staff: Staff[];
  assignments: Assignment[];
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

  const dowOf = (yyyymmdd: string) => {
    const d = new Date(`${yyyymmdd}T00:00:00+07:00`);
    return d.getUTCDay();
  };

  return (
    <>
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
            {positions.map((p) => (
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
                  return (
                    <td key={d} className="border border-slate-200 p-0 align-middle">
                      <button
                        type="button"
                        onClick={() => setEditing({ date: d, positionId: p.id })}
                        className={`w-full h-full min-h-[42px] px-1 py-1 text-[10px] hover:bg-slate-50 transition ${
                          a ? "" : "text-slate-300"
                        }`}
                        style={a?.shift_color ? { backgroundColor: a.shift_color } : undefined}
                      >
                        {a ? (
                          <>
                            <div className="font-bold leading-tight text-slate-800">
                              {a.user_display_name}
                            </div>
                            <div className="text-[9px] text-slate-700 mt-0.5">
                              {a.shift_code}
                            </div>
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
          {staffTotals.map((s) => (
            <div key={s.id} className="text-sm flex justify-between border-b border-slate-100 pb-1">
              <span className="text-slate-700 truncate">{s.name}</span>
              <span className="font-mono font-bold text-slate-800">{s.count}</span>
            </div>
          ))}
        </div>
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
          📣 {t("admin.persona.roster.publish.publishBtn")}
        </button>
        <button type="button"
          onClick={() => { setPublishKind("edit"); setPublishOpen(true); }}
          className="text-sm px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">
          ✏️ {t("admin.persona.roster.publish.editBtn")}
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
  date, positionId, position, existing, shiftCodes, staff, busy,
  onClose, onSave, onClear, t
}: {
  date: string; positionId: number;
  position: Position;
  existing: Assignment | null;
  shiftCodes: ShiftCode[];
  staff: Staff[];
  busy: boolean;
  onClose: () => void;
  onSave: (a: { date: string; positionId: number; userId: number; shiftCodeId: number }) => void;
  onClear: (a: { date: string; positionId: number }) => void;
  t: (k: string, vars?: Record<string, string | number>) => string;
}) {
  const [userId, setUserId] = useState<number | "">(existing?.user_id ?? "");
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
        <div>
          <label className="label">{t("admin.persona.roster.modal.staff")}</label>
          <select className="input" value={userId}
            onChange={(e) => setUserId(e.target.value === "" ? "" : Number(e.target.value))}>
            <option value="">— {t("admin.persona.roster.modal.pickStaff")} —</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.display_name} {s.employment_type ? `(${s.employment_type.toUpperCase()})` : ""}
              </option>
            ))}
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
