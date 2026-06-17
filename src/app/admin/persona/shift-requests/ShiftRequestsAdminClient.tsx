"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { nameWithPrefix } from "@/lib/name";
import { thMonthLabel, thDayLabel, groupByMonthDay } from "@/lib/th-month";
import type { ShiftRequestRow } from "@/lib/shift-requests";

type Row = ShiftRequestRow & {
  employee_name: string; title_prefix: string | null; employment_type: string | null;
};
type HistoryRow = Row & { decided_by_name: string | null };
type Position = { id: number; title: string };
type ShiftCodeOpt = { id: number; code: string; name: string | null; kind: string };
export type RosterCtx = {
  regularPositionId: number | null;
  occupiedWork: number[];
  offDatePositionId: number | null;
};

const KIND_TH: Record<string, string> = { extra_shift: "ขอเพิ่มกะ", swap: "ขอสลับวันหยุด" };

const STATUS_META: Record<string, { label: string; cls: string }> = {
  approved:  { label: "อนุมัติ",    cls: "bg-emerald-100 text-emerald-800" },
  rejected:  { label: "ไม่อนุมัติ", cls: "bg-rose-100 text-rose-700" },
  cancelled: { label: "ยกเลิก",     cls: "bg-slate-100 text-slate-500" }
};

export default function ShiftRequestsAdminClient({
  pending, history, positions, shiftCodes, defaultShiftCodeId, rosterCtx
}: {
  pending: Row[];
  history: HistoryRow[];
  positions: Position[];
  shiftCodes: ShiftCodeOpt[];
  defaultShiftCodeId: number | null;
  rosterCtx: Record<number, RosterCtx>;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [noteFor, setNoteFor] = useState<number | null>(null);
  const [note, setNote] = useState("");
  // Approve-and-assign modal target (the request being scheduled).
  const [assignFor, setAssignFor] = useState<Row | null>(null);

  async function reject(id: number) {
    setBusyId(id);
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/shift-request/${id}/decide`), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "rejected", note: note.trim() || undefined })
      });
      if (res.ok) { setNoteFor(null); setNote(""); router.refresh(); }
    } finally { setBusyId(null); }
  }

  // Group decided requests by month → day for the history view.
  const historyGroups = useMemo(
    () => groupByMonthDay(history, (r) => r.decided_at ?? r.created_at),
    [history]
  );

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-sm font-bold text-slate-700">รออนุมัติ</h2>
        {pending.length === 0 ? (
          <div className="card text-sm text-slate-400 text-center py-8">ไม่มีคำขอที่รออนุมัติ</div>
        ) : pending.map((r) => (
        <div key={r.id} className="card space-y-2">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div>
              <div className="font-bold text-slate-800">
                {nameWithPrefix(r.title_prefix, r.employee_name)}
                <span className="ml-2 text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">
                  {r.employment_type === "pt" ? "พาร์ทไทม์" : r.employment_type === "ft" ? "ประจำ" : "—"}
                </span>
              </div>
              <div className="text-sm text-brand font-semibold mt-0.5">
                {KIND_TH[r.kind]} <span className="font-mono text-[11px] text-slate-400">{r.ref_no}</span>
              </div>
              <div className="text-sm text-slate-600 mt-0.5">
                {r.kind === "swap"
                  ? `ขอหยุดวันที่ ${r.off_date} · ทำงานชดเชยวันที่ ${r.work_date}`
                  : `ขอทำงานเพิ่มวันที่ ${r.work_date}`}
              </div>
              {r.note && <div className="text-xs text-slate-500 mt-0.5">เหตุผล: {r.note}</div>}
            </div>
          </div>

          {noteFor === r.id && (
            <input className="input text-sm" value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="หมายเหตุถึงพนักงาน (ไม่บังคับ)" maxLength={500} />
          )}

          <div className="flex gap-2">
            <button type="button" disabled={busyId === r.id}
              onClick={() => { setNote(""); setNoteFor(null); setAssignFor(r); }}
              className="flex-1 py-2 rounded-lg bg-emerald-600 text-white text-sm font-bold disabled:opacity-50">
              อนุมัติ
            </button>
            <button type="button" disabled={busyId === r.id}
              onClick={() => { if (noteFor === r.id) reject(r.id); else { setNoteFor(r.id); setNote(""); } }}
              className="flex-1 py-2 rounded-lg border border-rose-300 text-rose-600 text-sm font-bold disabled:opacity-50">
              {noteFor === r.id ? "ยืนยันไม่อนุมัติ" : "ไม่อนุมัติ"}
            </button>
          </div>
        </div>
      ))}
      </div>

      {/* History — decided requests, grouped by month → day (owner 2026-06-17). */}
      <div className="space-y-2">
        <h2 className="text-sm font-bold text-slate-700">ประวัติคำขอ (อนุมัติ/ไม่อนุมัติแล้ว)</h2>
        {historyGroups.length === 0 ? (
          <div className="card text-sm text-slate-400 text-center py-6">ยังไม่มีประวัติ</div>
        ) : historyGroups.map(({ mk, days }, i) => (
          <details key={mk} open={i === 0} className="card">
            <summary className="cursor-pointer font-semibold text-slate-700 text-sm select-none">
              {thMonthLabel(mk)}{" "}
              <span className="text-[11px] text-slate-400 font-normal">
                · {days.reduce((s, [, rows]) => s + rows.length, 0)} รายการ
              </span>
            </summary>
            <div className="mt-2 space-y-3">
              {days.map(([d, rows]) => (
                <div key={d}>
                  <div className="text-[11px] font-bold text-slate-400 border-b border-slate-100 pb-1 mb-1">
                    {thDayLabel(d)}
                  </div>
                  <div className="space-y-1.5">
                    {rows.map((r) => {
                      const sm = STATUS_META[r.status] ?? { label: r.status, cls: "bg-slate-100 text-slate-500" };
                      return (
                        <div key={r.id} className="flex items-start justify-between gap-2 text-sm">
                          <div className="min-w-0">
                            <span className="font-medium text-slate-800">{nameWithPrefix(r.title_prefix, r.employee_name)}</span>
                            <span className="text-[11px] text-slate-400">
                              {" "}· {KIND_TH[r.kind]} · {r.kind === "swap"
                                ? `หยุด ${r.off_date} / ทำงาน ${r.work_date}`
                                : `ทำงานเพิ่ม ${r.work_date}`}
                            </span>
                            {r.decision_note && <div className="text-[11px] text-slate-500">หมายเหตุ: {r.decision_note}</div>}
                            {r.decided_by_name && <div className="text-[10px] text-slate-400">โดย {r.decided_by_name}</div>}
                          </div>
                          <span className={`flex-shrink-0 text-[10px] px-2 py-0.5 rounded-full font-bold ${sm.cls}`}>{sm.label}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>

      {assignFor && (
        <AssignModal
          row={assignFor}
          positions={positions}
          shiftCodes={shiftCodes}
          defaultShiftCodeId={defaultShiftCodeId}
          ctx={rosterCtx[assignFor.id] ?? { regularPositionId: null, occupiedWork: [], offDatePositionId: null }}
          onClose={() => setAssignFor(null)}
          onDone={() => { setAssignFor(null); router.refresh(); }}
        />
      )}
    </div>
  );
}

function AssignModal({
  row, positions, shiftCodes, defaultShiftCodeId, ctx, onClose, onDone
}: {
  row: Row;
  positions: Position[];
  shiftCodes: ShiftCodeOpt[];
  defaultShiftCodeId: number | null;
  ctx: RosterCtx;
  onClose: () => void;
  onDone: () => void;
}) {
  const occupied = new Set(ctx.occupiedWork);
  const emptyPositions = useMemo(
    () => positions.filter((p) => !occupied.has(p.id)),
    [positions, ctx.occupiedWork]
  );
  // Default to the staff's regular position when it's still free, else
  // the first empty position (owner 2026-06-06).
  const defaultPos = (ctx.regularPositionId != null && !occupied.has(ctx.regularPositionId))
    ? ctx.regularPositionId
    : (emptyPositions[0]?.id ?? null);
  const workShifts = shiftCodes.filter((s) => s.kind === "work");

  const [positionId, setPositionId] = useState<number | "">(defaultPos ?? "");
  const [shiftCodeId, setShiftCodeId] = useState<number | "">(
    defaultShiftCodeId ?? workShifts[0]?.id ?? ""
  );
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const name = nameWithPrefix(row.title_prefix, row.employee_name);
  const posTitle = positions.find((p) => p.id === positionId)?.title ?? "—";
  const canSubmit = positionId !== "" && shiftCodeId !== "" && /^\d{4}$/.test(pin) && !busy;

  async function confirm() {
    if (positionId === "" || shiftCodeId === "") { setErr("เลือกตำแหน่งและกะ"); return; }
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/shift-request/${row.id}/approve-assign`), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position_id: positionId, shift_code_id: shiftCodeId, pin })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setErr(
          j.error === "bad_pin" ? "PIN ไม่ถูกต้อง"
          : j.error === "slot_taken" ? "ตำแหน่งนี้ถูกใช้ไปแล้ว เลือกตำแหน่งอื่น"
          : j.error === "not_pending" ? "คำขอนี้ถูกดำเนินการไปแล้ว"
          : "ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง"
        );
        return;
      }
      onDone();
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-5 space-y-3 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-slate-800">อนุมัติคำขอ</h3>
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm text-slate-700 space-y-0.5">
          <div><b>{name}</b> · {KIND_TH[row.kind]}</div>
          <div className="text-xs text-slate-500">
            {row.kind === "swap"
              ? `หยุดวันที่ ${row.off_date} · ทำงานวันที่ ${row.work_date}`
              : `ทำงานเพิ่มวันที่ ${row.work_date}`}
          </div>
        </div>

        {emptyPositions.length === 0 ? (
          <p className="text-sm text-rose-600">
            วันที่ {row.work_date} ตำแหน่งเต็มทุกช่องแล้ว — ปลดบางตำแหน่งในหน้าตารางงานก่อน
          </p>
        ) : (
          <>
            <div>
              <label className="label">ตำแหน่งในวันที่ {row.work_date} *</label>
              <select className="input" value={positionId}
                onChange={(e) => setPositionId(e.target.value === "" ? "" : Number(e.target.value))}>
                <option value="">— เลือกตำแหน่งว่าง —</option>
                {emptyPositions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}{ctx.regularPositionId === p.id ? " (ตำแหน่งประจำ)" : ""}
                  </option>
                ))}
              </select>
              {ctx.regularPositionId != null && occupied.has(ctx.regularPositionId) && (
                <p className="text-[10px] text-amber-600 mt-1">
                  ตำแหน่งประจำถูกใช้ไปแล้วในวันนั้น — เลือกจากตำแหน่งว่างที่เหลือ
                </p>
              )}
            </div>
            <div>
              <label className="label">กะ *</label>
              <select className="input" value={shiftCodeId}
                onChange={(e) => setShiftCodeId(e.target.value === "" ? "" : Number(e.target.value))}>
                <option value="">— เลือกกะ —</option>
                {workShifts.map((s) => (
                  <option key={s.id} value={s.id}>{s.code}{s.name ? ` · ${s.name}` : ""}</option>
                ))}
              </select>
            </div>

            {/* Summary */}
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-800">
              จะลง <b>{name}</b> ที่ตำแหน่ง <b>{posTitle}</b> วันที่ <b>{row.work_date}</b>
              {row.kind === "swap" && row.off_date && (
                <> และปลดงานวันที่ <b>{row.off_date}</b></>
              )}
            </div>

            <div>
              <label className="label">PIN 4 หลักเพื่อยืนยัน</label>
              <input type="password" className="input tracking-[0.5em] text-center" inputMode="numeric" maxLength={4}
                value={pin} autoComplete="off"
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder="••••" />
            </div>
          </>
        )}

        {err && <p className="text-sm text-rose-600">✗ {err}</p>}
        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={busy}
            className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium">
            ยกเลิก
          </button>
          {emptyPositions.length > 0 && (
            <button type="button" onClick={confirm} disabled={!canSubmit}
              className="flex-1 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-bold disabled:opacity-40">
              {busy ? "กำลังบันทึก…" : "ยืนยัน"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
