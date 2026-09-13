"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { BreakSkipRow } from "@/lib/break-skip";

const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "รออนุมัติ", cls: "bg-amber-100 text-amber-700" },
  approved: { label: "อนุมัติแล้ว", cls: "bg-emerald-100 text-emerald-700" },
  rejected: { label: "ไม่อนุมัติ", cls: "bg-rose-100 text-rose-700" }
};

export default function BreakSkipClient({
  rows, today, todayBreak, hasActiveBranch
}: {
  rows: BreakSkipRow[];
  today: string;
  todayBreak: { start: string; end: string } | null;
  hasActiveBranch: boolean;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Local pre-check (server enforces authoritatively): before the break starts?
  const nowMin = (() => { const b = new Date(Date.now() + 7 * 3600_000); return b.getUTCHours() * 60 + b.getUTCMinutes(); })();
  const breakStartMin = todayBreak ? Number(todayBreak.start.slice(0, 2)) * 60 + Number(todayBreak.start.slice(3, 5)) : null;
  const approvedToday = rows.find((r) => r.work_date === today && r.status === "approved");
  const tooLate = breakStartMin != null && nowMin >= breakStartMin;
  // A pending request can be re-filed (edit the reason); only an approved one locks.
  const canRequest = hasActiveBranch && !!todayBreak && !tooLate && !approvedToday;

  async function submit() {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/persona/break-skip-requests"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() || undefined })
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        setMsg({ ok: true, text: "ส่งคำขอแล้ว รอหัวหน้าอนุมัติ" });
        setReason("");
        router.refresh();
      } else {
        const text = j.error === "already_approved" ? "วันนี้ได้รับอนุมัติแล้ว"
          : j.error === "no_break" ? "วันนี้ไม่มีเวลาพักให้ยกเลิก"
          : j.error === "too_late" ? "เลยเวลาพักของวันนี้แล้ว — ต้องยื่นก่อนถึงเวลาพัก"
          : j.error === "not_today" ? "ขอได้เฉพาะของวันนี้"
          : j.error === "no_active_branch" ? "ยังไม่ได้เลือกสาขา"
          : "ส่งคำขอไม่สำเร็จ ลองใหม่อีกครั้ง";
        setMsg({ ok: false, text });
      }
    } catch {
      setMsg({ ok: false, text: "เชื่อมต่อไม่ได้ ลองใหม่อีกครั้ง" });
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <h2 className="font-bold text-slate-800 text-sm">ยื่นคำขอสำหรับวันนี้ ({today})</h2>
        {!hasActiveBranch ? (
          <p className="text-sm text-slate-500">ยังไม่ได้เลือกสาขา — กรุณาลงเวลาเข้างานก่อน</p>
        ) : !todayBreak ? (
          <p className="text-sm text-slate-500">วันนี้ไม่มีเวลาพักในตารางเวร จึงไม่ต้องขอ</p>
        ) : (
          <>
            <p className="text-sm text-slate-600">
              เวลาพักของวันนี้: <b className="tabular-nums">{todayBreak.start}–{todayBreak.end}</b>
              {tooLate && <span className="block text-rose-600 mt-1">เลยเวลาพักแล้ว — ต้องยื่นก่อน {todayBreak.start}</span>}
              {approvedToday && <span className="block text-emerald-600 mt-1">วันนี้ได้รับอนุมัติแล้ว</span>}
            </p>
            <div>
              <label className="label">เหตุผล (ถ้ามี)</label>
              <textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
                disabled={busy || !canRequest} placeholder="เช่น งานเยอะ อยากทำต่อเนื่อง" maxLength={500} />
            </div>
            {msg && <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-rose-600"}`}>{msg.text}</p>}
            <div className="flex justify-end">
              <button type="button" disabled={busy || !canRequest} onClick={submit}
                className="text-sm px-4 py-2 rounded-lg bg-brand text-white font-medium disabled:opacity-40">
                {busy ? "กำลังส่ง…" : "ขอทำงานช่วงพัก"}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="card overflow-x-auto">
        <h2 className="font-bold text-slate-800 text-sm mb-2">คำขอของฉัน</h2>
        {rows.length === 0 ? (
          <p className="text-sm text-slate-400 py-4 text-center">ยังไม่มีคำขอ</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                <th className="py-2 pr-3">วันที่</th>
                <th className="py-2 pr-3">เวลาพักที่ขอไม่พัก</th>
                <th className="py-2 pr-3">เหตุผล</th>
                <th className="py-2 pr-3">สถานะ</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 last:border-0 align-top">
                  <td className="py-2 pr-3 whitespace-nowrap tabular-nums text-slate-700">{r.work_date}</td>
                  <td className="py-2 pr-3 whitespace-nowrap tabular-nums text-slate-600">{r.break_label ?? "—"}</td>
                  <td className="py-2 pr-3 text-slate-600">
                    {r.reason ?? "—"}
                    {r.decision_note && <span className="block text-[11px] text-slate-400 mt-0.5">หมายเหตุ: {r.decision_note}</span>}
                  </td>
                  <td className="py-2 pr-3">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${STATUS[r.status].cls}`}>
                      {STATUS[r.status].label}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
