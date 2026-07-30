"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import PinPromptModal from "@/app/components/PinPromptModal";
import type { PendingEarlyLeave } from "@/lib/early-leave";

const PIN_ERRORS = new Set(["wrong_pin", "pin_invalid", "no_pin", "user_not_found"]);

export default function EarlyLeaveAdminClient({ pending }: { pending: PendingEarlyLeave[] }) {
  const router = useRouter();
  const [rows, setRows] = useState<PendingEarlyLeave[]>(pending);
  const [err, setErr] = useState<string | null>(null);
  // The decision awaiting a PIN: which row + approve/reject.
  const [ask, setAsk] = useState<{ row: PendingEarlyLeave; decision: "approved" | "rejected" } | null>(null);

  async function submit(pin: string): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!ask) return { ok: false, message: "ไม่มีรายการ" };
    const res = await fetch(apiUrl("/api/admin/persona/early-leave-requests"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: ask.row.user_id, work_date: ask.row.work_date, decision: ask.decision, pin })
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.ok) {
      setRows((rs) => rs.filter((r) => r.id !== ask.row.id));
      setAsk(null);
      router.refresh();
      return { ok: true };
    }
    if (PIN_ERRORS.has(j.error)) return { ok: false, message: "pin_invalid" };
    return { ok: false, message: "ทำรายการไม่สำเร็จ" };
  }

  return (
    <div className="space-y-3">
      {err && <div className="text-sm text-rose-600">{err}</div>}
      {rows.length === 0 ? (
        <div className="card text-sm text-slate-400">ไม่มีคำขอค้างอยู่</div>
      ) : (
        <div className="card divide-y divide-slate-100">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <div className="font-medium text-slate-800">{r.name}</div>
                <div className="text-xs text-slate-500">
                  วันที่ {r.work_date}
                  {r.reason && <span className="text-slate-400"> · {r.reason}</span>}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => { setErr(null); setAsk({ row: r, decision: "approved" }); }}
                  className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-bold hover:opacity-90"
                >
                  อนุมัติ
                </button>
                <button
                  onClick={() => { setErr(null); setAsk({ row: r, decision: "rejected" }); }}
                  className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 font-medium hover:bg-slate-50"
                >
                  ปฏิเสธ
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {ask && (
        <PinPromptModal
          title={ask.decision === "approved" ? "ยืนยันอนุมัติออกก่อน" : "ยืนยันปฏิเสธ"}
          description={
            <>
              {ask.decision === "approved" ? "อนุมัติ" : "ปฏิเสธ"}คำขอออกก่อนเวลาของ <b>{ask.row.name}</b> วันที่ {ask.row.work_date}
              {ask.decision === "approved" && <> — จะไม่หักค่าเครดิตอาหารจาก Service Charge</>}
              <br />กรอก PIN 4 หลักของคุณเพื่อยืนยัน
            </>
          }
          submitLabel="ยืนยัน"
          onSubmit={submit}
          onClose={() => setAsk(null)}
        />
      )}
    </div>
  );
}
