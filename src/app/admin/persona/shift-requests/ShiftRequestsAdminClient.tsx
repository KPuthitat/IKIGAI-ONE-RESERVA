"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { nameWithPrefix } from "@/lib/name";
import type { ShiftRequestRow } from "@/lib/shift-requests";

type Row = ShiftRequestRow & {
  employee_name: string; title_prefix: string | null; employment_type: string | null;
};
const KIND_TH: Record<string, string> = { extra_shift: "ขอเพิ่มกะ", swap: "ขอสลับวันหยุด" };

export default function ShiftRequestsAdminClient({ pending }: { pending: Row[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [noteFor, setNoteFor] = useState<number | null>(null);
  const [note, setNote] = useState("");

  async function decide(id: number, decision: "approved" | "rejected") {
    setBusyId(id);
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/shift-request/${id}/decide`), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, note: note.trim() || undefined })
      });
      if (res.ok) { setNoteFor(null); setNote(""); router.refresh(); }
    } finally { setBusyId(null); }
  }

  if (pending.length === 0) {
    return <div className="card text-sm text-slate-400 text-center py-8">ไม่มีคำร้องที่รออนุมัติ</div>;
  }

  return (
    <div className="space-y-2">
      {pending.map((r) => (
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
              onClick={() => decide(r.id, "approved")}
              className="flex-1 py-2 rounded-lg bg-emerald-600 text-white text-sm font-bold disabled:opacity-50">
              อนุมัติ
            </button>
            <button type="button" disabled={busyId === r.id}
              onClick={() => { if (noteFor === r.id) decide(r.id, "rejected"); else { setNoteFor(r.id); setNote(""); } }}
              className="flex-1 py-2 rounded-lg border border-rose-300 text-rose-600 text-sm font-bold disabled:opacity-50">
              {noteFor === r.id ? "ยืนยันไม่อนุมัติ" : "ไม่อนุมัติ"}
            </button>
          </div>
          <p className="text-[10px] text-slate-400">
            อนุมัติแล้วอย่าลืมจัดลงตารางงาน (Roster) ให้พนักงานด้วย
          </p>
        </div>
      ))}
    </div>
  );
}
