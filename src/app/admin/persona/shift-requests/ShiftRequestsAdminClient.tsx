"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { nameWithPrefix } from "@/lib/name";
import { thMonthLabel, thDayLabel, groupByMonthDay } from "@/lib/th-month";
import type { ShiftRequestRow, ShiftRequestLabels } from "@/lib/shift-requests";

type Row = ShiftRequestRow & ShiftRequestLabels & {
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

type StaffOpt = { id: number; display_name: string; title_prefix: string | null; employment_type: string | null; regularPositionId: number | null };

const KIND_TH: Record<string, string> = { extra_shift: "ขอเพิ่มกะ", swap: "ขอสลับวันหยุด" };

const STATUS_META: Record<string, { label: string; cls: string }> = {
  approved:  { label: "อนุมัติ",    cls: "bg-emerald-100 text-emerald-800" },
  rejected:  { label: "ไม่อนุมัติ", cls: "bg-rose-100 text-rose-700" },
  cancelled: { label: "ยกเลิก",     cls: "bg-slate-100 text-slate-500" }
};

export default function ShiftRequestsAdminClient({
  pending, history, positions, shiftCodes, defaultShiftCodeId, rosterCtx, staff
}: {
  pending: Row[];
  history: HistoryRow[];
  positions: Position[];
  shiftCodes: ShiftCodeOpt[];
  defaultShiftCodeId: number | null;
  rosterCtx: Record<number, RosterCtx>;
  staff: StaffOpt[];
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
      <OnBehalfCard staff={staff} positions={positions} shiftCodes={shiftCodes} defaultShiftCodeId={defaultShiftCodeId} />
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
              {r.kind === "extra_shift" && (r.position_title || r.shift_code) && (
                <div className="text-xs text-emerald-700 mt-0.5">
                  ขอตำแหน่ง: <b>{r.position_title ?? "—"}</b>{r.shift_code ? <> · เวลา <b>{r.shift_code}{r.shift_name ? ` (${r.shift_name})` : ""}</b></> : null}
                </div>
              )}
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
  // Default to what the STAFF requested when it's still free (owner 2026-07-31 —
  // the admin should just approve), then fall back to the staff's regular
  // position, else the first empty position.
  const defaultPos =
    (row.position_id != null && !occupied.has(row.position_id))
      ? row.position_id
      : (ctx.regularPositionId != null && !occupied.has(ctx.regularPositionId))
        ? ctx.regularPositionId
        : (emptyPositions[0]?.id ?? null);
  const workShifts = shiftCodes.filter((s) => s.kind === "work");
  // Prefill the staff's requested shift when valid.
  const requestedShiftValid = row.shift_code_id != null && workShifts.some((s) => s.id === row.shift_code_id);

  const [positionId, setPositionId] = useState<number | "">(defaultPos ?? "");
  const [shiftCodeId, setShiftCodeId] = useState<number | "">(
    (requestedShiftValid ? row.shift_code_id : null) ?? defaultShiftCodeId ?? workShifts[0]?.id ?? ""
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
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


// Record an extra-shift request FOR an employee, already approved + on the roster
// (owner 2026-10-04) — e.g. a day worked on a day off that was never requested. A
// monthly employee then gets the rest-day pay; draft payroll is refreshed.
function OnBehalfCard({ staff, positions, shiftCodes, defaultShiftCodeId }: {
  staff: StaffOpt[]; positions: Position[]; shiftCodes: ShiftCodeOpt[]; defaultShiftCodeId: number | null;
}) {
  const router = useRouter();
  const works = shiftCodes.filter((s) => s.kind === "work");
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState<number | "">("");
  const [date, setDate] = useState("");
  const [shiftId, setShiftId] = useState<number | "">(defaultShiftCodeId ?? "");
  const [posId, setPosId] = useState<number | "">("");
  const [note, setNote] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const emp = staff.find((s) => s.id === userId);
  function pickUser(id: number | "") {
    setUserId(id);
    const u = staff.find((s) => s.id === id);
    if (u?.regularPositionId) setPosId(u.regularPositionId);
  }
  async function save() {
    if (userId === "" || !date || shiftId === "" || posId === "") { setMsg({ kind: "err", text: "เลือกพนักงาน วันที่ กะ และตำแหน่งให้ครบ" }); return; }
    if (note.trim().length < 3) { setMsg({ kind: "err", text: "ใส่เหตุผล เช่น ทำงานวันหยุดตามที่ตกลงไว้ ไม่ได้ส่งคำขอ" }); return; }
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/shift-request/on-behalf"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, work_date: date, position_id: posId, shift_code_id: shiftId, pin, note: note.trim() })
      });
      const j = await res.json().catch(() => ({})) as { ok?: boolean; error?: string; ref_no?: string; recomputedPeriods?: number[] };
      if (!res.ok || !j.ok) {
        const m = j.error === "bad_pin" ? "PIN ไม่ถูกต้อง" : j.error === "slot_taken" ? "ตำแหน่งนี้มีคนอยู่แล้วในวันนั้น เลือกตำแหน่งอื่น"
          : j.error === "already_approved" ? "วันนั้นมีคำขอเพิ่มกะที่อนุมัติแล้ว" : j.error === "user_not_in_branch" ? "พนักงานไม่อยู่ในสาขานี้" : "บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง";
        setMsg({ kind: "err", text: m }); return;
      }
      setMsg({ kind: "ok", text: `บันทึกแล้ว (${j.ref_no})${(j.recomputedPeriods?.length ?? 0) > 0 ? " · คำนวณรอบเงินเดือนที่ยังเป็นร่างใหม่ให้แล้ว" : ""}` });
      setUserId(""); setDate(""); setNote(""); setPin("");
      router.refresh();
    } catch { setMsg({ kind: "err", text: "เชื่อมต่อไม่ได้ ลองใหม่อีกครั้ง" }); }
    finally { setBusy(false); }
  }

  return (
    <div className="card space-y-3">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between text-left">
        <span className="text-sm font-bold text-slate-700">+ บันทึกคำขอเพิ่มกะแทนพนักงาน</span>
        <span className="text-slate-400 text-sm">{open ? "ซ่อน ▲" : "เปิด ▼"}</span>
      </button>
      {open && (
        <div className="space-y-3">
          <p className="text-[11px] text-slate-500">
            ใช้เมื่อพนักงานมาทำงานในวันที่ไม่มีกะ แต่ไม่ได้ส่งคำขอในระบบ — ระบบสร้างคำขอที่อนุมัติแล้ว จัดกะลงตาราง และคำนวณรอบเงินเดือนที่ยังเป็นร่างใหม่ให้
            (พนักงานเงินเดือนได้ค่าทำงานวันหยุดตามกฎหมาย · ย้อนหลังได้ · ต้องใส่ PIN)
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">พนักงาน</label>
              <select className="input" value={userId} onChange={(e) => pickUser(e.target.value ? Number(e.target.value) : "")}>
                <option value="">— เลือก —</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {nameWithPrefix(s.title_prefix, s.display_name)} · {s.employment_type === "pt" ? "พาร์ทไทม์" : s.employment_type === "ft" ? "ประจำ" : "—"}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">วันที่ทำงาน</label>
              <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <label className="label">กะ</label>
              <select className="input" value={shiftId} onChange={(e) => setShiftId(e.target.value ? Number(e.target.value) : "")}>
                <option value="">— เลือก —</option>
                {works.map((s) => <option key={s.id} value={s.id}>{s.code}{s.name ? ` (${s.name})` : ""}</option>)}
              </select>
            </div>
            <div>
              <label className="label">ตำแหน่ง</label>
              <select className="input" value={posId} onChange={(e) => setPosId(e.target.value ? Number(e.target.value) : "")}>
                <option value="">— เลือก —</option>
                {positions.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
              </select>
            </div>
          </div>
          {emp?.employment_type === "pt" && (
            <p className="text-[11px] text-amber-700">พนักงานพาร์ทไทม์: คิดค่าตอบแทนเป็นกะปกติ ไม่มีส่วนเพิ่มวันหยุด</p>
          )}
          <div>
            <label className="label">เหตุผล (เก็บไว้ในคำขอ)</label>
            <input className="input" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="เช่น ทำงานวันหยุดตามที่ตกลงไว้ แต่ไม่ได้ส่งคำขอในระบบ" />
          </div>
          <div className="flex items-end gap-3 flex-wrap">
            <div>
              <label className="label">PIN แอดมิน</label>
              <input type="password" inputMode="numeric" autoComplete="off" className="input w-28 tracking-widest text-center" value={pin} onChange={(e) => setPin(e.target.value)} />
            </div>
            <button type="button" onClick={save} disabled={busy} className="btn-primary text-sm disabled:opacity-50">{busy ? "กำลังบันทึก…" : "บันทึกและอนุมัติ"}</button>
          </div>
          {msg && <p className={`text-sm ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>{msg.text}</p>}
        </div>
      )}
    </div>
  );
}
