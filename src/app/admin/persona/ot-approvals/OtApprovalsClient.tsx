"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { nameWithPrefix } from "@/lib/name";
import { thMonthLabel, thDayLabel, groupByMonthDay } from "@/lib/th-month";
import PinPromptModal from "@/app/components/PinPromptModal";

type SegStatus = "pending" | "approved" | "rejected";

export type OtRow = {
  id: number;
  user_id: number;
  work_date: string;
  requested_until: string;
  requested_from: string | null;  // early-start OT (HH:MM); null = no early request
  status: SegStatus;              // governs the late-end segment (requested_until)
  early_status: SegStatus | null; // governs the early-start segment (requested_from)
  created_at: string;
  decided_at: string | null;
  display_name: string;
  title_prefix: string | null;
  branch_name: string | null;
  decided_by_name: string | null;
};

export type OtStaff = {
  id: number;
  display_name: string;
  title_prefix: string | null;
  employment_type: "pt" | "ft" | null;
};

const STATUS_META: Record<SegStatus, { label: string; cls: string }> = {
  pending: { label: "รออนุมัติ", cls: "bg-amber-100 text-amber-700" },
  approved: { label: "อนุมัติแล้ว", cls: "bg-emerald-100 text-emerald-700" },
  rejected: { label: "ไม่อนุมัติ", cls: "bg-rose-100 text-rose-600" }
};

// Late/early are independent segments (owner 2026-08-04). A row is "actionable"
// (needs an admin decision) when a segment exists and is still pending.
const hasLate = (r: OtRow) => !!r.requested_until && r.requested_until.length > 0;
const hasEarly = (r: OtRow) => !!r.requested_from;
const lateActionable = (r: OtRow) => hasLate(r) && r.status === "pending";
const earlyActionable = (r: OtRow) => hasEarly(r) && r.early_status === "pending";
const isActionable = (r: OtRow) => lateActionable(r) || earlyActionable(r);

export default function OtApprovalsClient({ rows, staff }: { rows: OtRow[]; staff: OtStaff[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const refresh = () => startTransition(() => router.refresh());

  const pending = rows.filter(isActionable);
  const decided = rows.filter((r) => !isActionable(r));

  return (
    <div className="space-y-4">
      <AddOtForm staff={staff} onAdded={refresh} />

      <div className="card space-y-3">
        <h2 className="font-bold text-slate-800 text-sm">รออนุมัติ ({pending.length})</h2>
        {pending.length === 0 && <p className="text-sm text-slate-400">ไม่มีคำขอที่รออนุมัติ</p>}
        {pending.map((r) => <PendingRow key={r.id} row={r} onChanged={refresh} />)}
      </div>

      {/* ประวัติ — decided OT grouped by month → day (owner 2026-06-17). */}
      <div className="space-y-2">
        <h2 className="text-sm font-bold text-slate-700">ประวัติ OT (อนุมัติ/ไม่อนุมัติแล้ว)</h2>
        {decided.length === 0 ? (
          <div className="card text-sm text-slate-400 text-center py-6">ยังไม่มีประวัติ</div>
        ) : groupByMonthDay(decided, (r) => r.work_date).map(({ mk, days }, i) => (
          <details key={mk} open={i === 0} className="card">
            <summary className="cursor-pointer font-semibold text-slate-700 text-sm select-none">
              {thMonthLabel(mk)}{" "}
              <span className="text-[11px] text-slate-400 font-normal">
                · {days.reduce((s, [, rs]) => s + rs.length, 0)} รายการ
              </span>
            </summary>
            <div className="mt-2 space-y-3">
              {days.map(([d, rs]) => (
                <div key={d}>
                  <div className="text-[11px] font-bold text-slate-400 border-b border-slate-100 pb-1 mb-1">
                    {thDayLabel(d)}
                  </div>
                  <div className="space-y-1.5">
                    {rs.map((r) => (
                      <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        <span className="font-medium text-slate-700">{nameWithPrefix(r.title_prefix, r.display_name)}</span>
                        {hasEarly(r) && (
                          <span className="flex items-center gap-1 text-xs text-emerald-600">
                            เข้าก่อน {r.requested_from} น.
                            <SegBadge status={r.early_status ?? "pending"} />
                          </span>
                        )}
                        {hasLate(r) && (
                          <span className="flex items-center gap-1 text-xs text-slate-500">
                            ถึง {r.requested_until} น.
                            <SegBadge status={r.status} />
                          </span>
                        )}
                        {r.decided_by_name && (
                          <span className="text-[11px] text-slate-400 ml-auto">โดย {r.decided_by_name}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

function SegBadge({ status }: { status: SegStatus }) {
  const m = STATUS_META[status];
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${m.cls}`}>{m.label}</span>
  );
}

// Admin grants OT directly to a staff member (owner 2026-06-14). Creates an
// already-approved request via POST /api/admin/persona/ot-requests. Requires
// the admin PIN because it changes a pay value.
function AddOtForm({ staff, onAdded }: { staff: OtStaff[]; onAdded: () => void }) {
  const todayBkk = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const [userId, setUserId] = useState<string>("");
  const [date, setDate] = useState(todayBkk);
  const [until, setUntil] = useState("");
  const [from, setFrom] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pinOpen, setPinOpen] = useState(false);

  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  const validUntil = HHMM.test(until);
  const validFrom = HHMM.test(from);
  // At least one of early-start / late-end is required (owner 2026-07-28).
  const ready = userId !== "" && /^\d{4}-\d{2}-\d{2}$/.test(date) && (validUntil || validFrom);

  async function submit(pin: string): Promise<{ ok: true } | { ok: false; message: string }> {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/ot-requests"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: Number(userId), work_date: date,
          ...(validUntil ? { requested_until: until } : {}),
          ...(validFrom ? { requested_from: from } : {}),
          pin
        })
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) {
        setMsg("เพิ่ม OT เรียบร้อย (อนุมัติแล้ว · คำนวณให้อัตโนมัติ)");
        setUntil("");
        setFrom("");
        onAdded();
        return { ok: true };
      }
      const m = j?.error === "wrong_pin" ? "PIN ไม่ถูกต้อง"
        : j?.error === "no_pin" ? "ยังไม่ได้ตั้ง PIN"
        : j?.error === "not_eligible_for_ot" ? "พนักงานนี้ไม่มีประเภทการจ้าง (PT/FT)"
        : j?.error === "user_not_in_branch" ? "ไม่พบพนักงานในสาขานี้"
        : j?.error ?? "ไม่สำเร็จ";
      setErr(m);
      return { ok: false, message: m };
    } finally { setBusy(false); }
  }

  if (staff.length === 0) return null;

  return (
    <div className="card space-y-3">
      <div>
        <h2 className="font-bold text-slate-800 text-sm">เพิ่ม OT ให้พนักงาน</h2>
        <p className="text-[11px] text-slate-500">
          สำหรับพนักงานที่ทำ OT แต่ไม่ได้กดขอเอง — กรอกเวลาที่ทำถึง และ/หรือ เข้าก่อนเวลา ระบบบันทึกเป็น &quot;อนุมัติแล้ว&quot; + คำนวณ OT ให้อัตโนมัติ (ทั้ง PT/FT · เข้าก่อน = เกิน 8 ชม./วันเป็น OT)
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="text-[11px] text-slate-500 block">พนักงาน</label>
          <select className="input !w-auto !py-1 text-sm" value={userId}
            onChange={(e) => { setUserId(e.target.value); setErr(null); setMsg(null); }}>
            <option value="">— เลือก —</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {nameWithPrefix(s.title_prefix, s.display_name)} ({s.employment_type === "ft" ? "FT" : "PT"})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[11px] text-slate-500 block">วันที่</label>
          <input type="date" className="input !w-auto !py-1 text-sm" value={date}
            onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label className="text-[11px] text-slate-500 block">เข้าก่อนเวลา</label>
          <input type="time" className="input !w-auto !py-1 text-sm" value={from}
            onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="text-[11px] text-slate-500 block">ทำถึงเวลา</label>
          <input type="time" className="input !w-auto !py-1 text-sm" value={until}
            onChange={(e) => setUntil(e.target.value)} />
        </div>
        <button type="button" disabled={busy || !ready} onClick={() => setPinOpen(true)}
          className="text-xs px-4 py-1.5 rounded-md bg-brand text-white font-bold hover:opacity-90 disabled:opacity-50">
          เพิ่ม OT
        </button>
      </div>
      {err && <p className="text-xs text-rose-600">{err}</p>}
      {msg && <p className="text-xs text-emerald-700 font-medium">{msg}</p>}
      {pinOpen && (
        <PinPromptModal
          title="ยืนยันเพิ่ม OT"
          description={<>
            เพิ่ม OT วันที่ {date}
            {validFrom && <> · เข้าก่อน <b>{from}</b> น.</>}
            {validUntil && <> · ถึง <b>{until}</b> น.</>}
            {" "}— กระทบเงินเดือน ต้องใส่ PIN
          </>}
          submitLabel="เพิ่ม OT"
          onSubmit={submit}
          onClose={() => setPinOpen(false)}
        />
      )}
    </div>
  );
}

function PendingRow({ row, onChanged }: { row: OtRow; onChanged: () => void }) {
  return (
    <div className="border-t border-slate-100 pt-3 space-y-2 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-bold text-slate-800 text-sm">{nameWithPrefix(row.title_prefix, row.display_name)}</span>
        <span className="text-xs text-slate-500">{row.branch_name ?? "—"} · วันที่ {row.work_date}</span>
        {/* If one segment is already decided, show it for context. */}
        {hasEarly(row) && !earlyActionable(row) && (
          <span className="flex items-center gap-1 text-[11px] text-slate-400">เข้าก่อน {row.requested_from} น. <SegBadge status={row.early_status ?? "pending"} /></span>
        )}
        {hasLate(row) && !lateActionable(row) && (
          <span className="flex items-center gap-1 text-[11px] text-slate-400">ถึง {row.requested_until} น. <SegBadge status={row.status} /></span>
        )}
      </div>
      {earlyActionable(row) && (
        <SegmentEditor row={row} segment="early" onChanged={onChanged} />
      )}
      {lateActionable(row) && (
        <SegmentEditor row={row} segment="late" onChanged={onChanged} />
      )}
    </div>
  );
}

// One approve/reject control for a single OT segment (early-start or late-end).
// Editing the time is a pay change → PIN. Only this segment's status is touched.
function SegmentEditor({
  row, segment, onChanged
}: { row: OtRow; segment: "late" | "early"; onChanged: () => void }) {
  const initial = segment === "late" ? row.requested_until : (row.requested_from ?? "");
  const [time, setTime] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const changed = time !== initial;
  const label = segment === "late" ? "ขอทำถึง" : "เข้าก่อนเวลา";
  const timeField = segment === "late" ? "requested_until" : "requested_from";

  async function patch(action: "approve" | "reject", pin?: string): Promise<{ ok: true } | { ok: false; message: string }> {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = { action, segment };
      if (action === "approve" && changed) { body[timeField] = time; if (pin) body.pin = pin; }
      const res = await fetch(apiUrl(`/api/admin/persona/ot-requests/${row.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) { onChanged(); return { ok: true }; }
      const msg = j?.error === "wrong_pin" ? "PIN ไม่ถูกต้อง"
        : j?.error === "no_pin" ? "ยังไม่ได้ตั้ง PIN"
        : j?.error ?? "ไม่สำเร็จ";
      setErr(msg);
      return { ok: false, message: msg };
    } finally { setBusy(false); }
  }

  function onApprove() {
    if (changed) setPinOpen(true);   // editing the time needs PIN
    else void patch("approve");
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
          segment === "early" ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-slate-100 text-slate-600"
        }`}>
          {segment === "early" ? "เข้าก่อนเวลา (OT)" : "อยู่เกินเวลา (OT)"}
        </span>
        <label className="text-xs text-slate-500">{label}</label>
        <input type="time" className="input !w-auto !py-1 text-sm" value={time}
          onChange={(e) => setTime(e.target.value)} />
        {changed && <span className="text-[11px] text-amber-700">แก้เวลา — ต้องใส่ PIN</span>}
        <div className="flex gap-2 ml-auto">
          <button type="button" disabled={busy} onClick={() => void patch("reject")}
            className="text-xs px-3 py-1.5 rounded-md border border-rose-300 text-rose-600 hover:bg-rose-50 disabled:opacity-50">
            ไม่อนุมัติ
          </button>
          <button type="button" disabled={busy} onClick={onApprove}
            className="text-xs px-4 py-1.5 rounded-md bg-emerald-500 text-white font-bold hover:bg-emerald-600 disabled:opacity-50">
            อนุมัติ
          </button>
        </div>
      </div>
      {err && <p className="text-xs text-rose-600">{err}</p>}
      {pinOpen && (
        <PinPromptModal
          title="ยืนยันแก้เวลา OT"
          description={<>แก้เวลาเป็น <b>{time}</b> น. แล้วอนุมัติ — ต้องใส่ PIN</>}
          submitLabel="อนุมัติ"
          onSubmit={(pin) => patch("approve", pin)}
          onClose={() => setPinOpen(false)}
        />
      )}
    </div>
  );
}
