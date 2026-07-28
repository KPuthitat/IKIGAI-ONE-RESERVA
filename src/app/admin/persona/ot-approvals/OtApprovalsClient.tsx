"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { nameWithPrefix } from "@/lib/name";
import { thMonthLabel, thDayLabel, groupByMonthDay } from "@/lib/th-month";
import PinPromptModal from "@/app/components/PinPromptModal";

export type OtRow = {
  id: number;
  user_id: number;
  work_date: string;
  requested_until: string;
  requested_from: string | null;  // early-start OT (HH:MM); null = late-OT only
  status: "pending" | "approved" | "rejected";
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

const STATUS_META: Record<OtRow["status"], { label: string; cls: string }> = {
  pending: { label: "รออนุมัติ", cls: "bg-amber-100 text-amber-700" },
  approved: { label: "อนุมัติแล้ว", cls: "bg-emerald-100 text-emerald-700" },
  rejected: { label: "ไม่อนุมัติ", cls: "bg-rose-100 text-rose-600" }
};

export default function OtApprovalsClient({ rows, staff }: { rows: OtRow[]; staff: OtStaff[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const refresh = () => startTransition(() => router.refresh());

  const pending = rows.filter((r) => r.status === "pending");
  const decided = rows.filter((r) => r.status !== "pending");

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
                        {r.requested_from && <span className="text-xs text-emerald-600">เข้าก่อน {r.requested_from} น.</span>}
                        {r.requested_until && <span className="text-xs text-slate-500">ถึง {r.requested_until} น.</span>}
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${STATUS_META[r.status].cls}`}>
                          {STATUS_META[r.status].label}
                        </span>
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

// Admin grants OT directly to a staff member (owner 2026-06-14). Creates an
// already-approved request via POST /api/admin/persona/ot-requests. Requires
// the admin PIN because it changes a pay value.
function AddOtForm({ staff, onAdded }: { staff: OtStaff[]; onAdded: () => void }) {
  const todayBkk = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const [userId, setUserId] = useState<string>("");
  const [date, setDate] = useState(todayBkk);
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pinOpen, setPinOpen] = useState(false);

  const ready = userId !== "" && /^\d{4}-\d{2}-\d{2}$/.test(date) && /^([01]\d|2[0-3]):[0-5]\d$/.test(until);

  async function submit(pin: string): Promise<{ ok: true } | { ok: false; message: string }> {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/ot-requests"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: Number(userId), work_date: date, requested_until: until, pin })
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) {
        setMsg("เพิ่ม OT เรียบร้อย (อนุมัติแล้ว)");
        setUntil("");
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
          สำหรับพนักงานที่ทำ OT แต่ไม่ได้กดขอเอง — กรอกเวลาที่ทำถึง ระบบจะบันทึกเป็น &quot;อนุมัติแล้ว&quot; ทันที (ทั้ง PT/FT)
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
          description={<>เพิ่ม OT ถึง <b>{until}</b> น. วันที่ {date} — กระทบเงินเดือน ต้องใส่ PIN</>}
          submitLabel="เพิ่ม OT"
          onSubmit={submit}
          onClose={() => setPinOpen(false)}
        />
      )}
    </div>
  );
}

function PendingRow({ row, onChanged }: { row: OtRow; onChanged: () => void }) {
  const [until, setUntil] = useState(row.requested_until);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const changed = until !== row.requested_until;

  async function patch(action: "approve" | "reject", pin?: string): Promise<{ ok: true } | { ok: false; message: string }> {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = { action };
      if (action === "approve" && changed) { body.requested_until = until; if (pin) body.pin = pin; }
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
    <div className="border-t border-slate-100 pt-3 space-y-2 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-bold text-slate-800 text-sm">{nameWithPrefix(row.title_prefix, row.display_name)}</span>
        <span className="text-xs text-slate-500">{row.branch_name ?? "—"} · วันที่ {row.work_date}</span>
        {row.requested_from && (
          <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
            เข้าก่อนเวลา {row.requested_from} น. (ขอ OT)
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-slate-500">ขอทำถึง</label>
        <input type="time" className="input !w-auto !py-1 text-sm" value={until}
          onChange={(e) => setUntil(e.target.value)} />
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
          description={<>แก้เวลาที่อนุมัติเป็น <b>{until}</b> น. แล้วอนุมัติ — ต้องใส่ PIN</>}
          submitLabel="อนุมัติ"
          onSubmit={(pin) => patch("approve", pin)}
          onClose={() => setPinOpen(false)}
        />
      )}
    </div>
  );
}
