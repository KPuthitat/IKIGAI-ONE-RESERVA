"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { nameWithPrefix } from "@/lib/name";
import PinPromptModal from "@/app/components/PinPromptModal";

export type OtRow = {
  id: number;
  user_id: number;
  work_date: string;
  requested_until: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  decided_at: string | null;
  display_name: string;
  title_prefix: string | null;
  branch_name: string | null;
  decided_by_name: string | null;
};

const STATUS_META: Record<OtRow["status"], { label: string; cls: string }> = {
  pending: { label: "รออนุมัติ", cls: "bg-amber-100 text-amber-700" },
  approved: { label: "อนุมัติแล้ว", cls: "bg-emerald-100 text-emerald-700" },
  rejected: { label: "ไม่อนุมัติ", cls: "bg-rose-100 text-rose-600" }
};

export default function OtApprovalsClient({ rows }: { rows: OtRow[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const refresh = () => startTransition(() => router.refresh());

  const pending = rows.filter((r) => r.status === "pending");
  const decided = rows.filter((r) => r.status !== "pending");

  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <h2 className="font-bold text-slate-800 text-sm">รออนุมัติ ({pending.length})</h2>
        {pending.length === 0 && <p className="text-sm text-slate-400">ไม่มีคำขอที่รออนุมัติ</p>}
        {pending.map((r) => <PendingRow key={r.id} row={r} onChanged={refresh} />)}
      </div>

      {decided.length > 0 && (
        <div className="card space-y-2">
          <h2 className="font-bold text-slate-800 text-sm">ประวัติล่าสุด</h2>
          {decided.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-100 pt-2 text-sm">
              <span className="font-medium text-slate-700">{nameWithPrefix(r.title_prefix, r.display_name)}</span>
              <span className="text-xs text-slate-500">{r.work_date} · ถึง {r.requested_until} น.</span>
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${STATUS_META[r.status].cls}`}>
                {STATUS_META[r.status].label}
              </span>
              {r.decided_by_name && (
                <span className="text-[11px] text-slate-400 ml-auto">โดย {r.decided_by_name}</span>
              )}
            </div>
          ))}
        </div>
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
