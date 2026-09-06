"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { LateExcusalRow } from "@/lib/late-excusals";

const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "รออนุมัติ", cls: "bg-amber-100 text-amber-700" },
  approved: { label: "อนุมัติ (อนุโลมแล้ว)", cls: "bg-emerald-100 text-emerald-700" },
  rejected: { label: "ไม่อนุมัติ", cls: "bg-rose-100 text-rose-700" }
};

export default function LateExcusalClient({ rows, prefillDate }: { rows: LateExcusalRow[]; prefillDate?: string }) {
  const router = useRouter();
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const [date, setDate] = useState(prefillDate ?? today);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit() {
    if (reason.trim().length < 3) { setMsg({ ok: false, text: "กรุณากรอกเหตุผล" }); return; }
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/persona/late-excusal"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ work_date: date, reason: reason.trim() })
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        setMsg({ ok: true, text: "ส่งคำขอแล้ว รอหัวหน้าพิจารณา" });
        setReason("");
        router.refresh();
      } else {
        const text = j.error === "already_approved" ? "วันนี้ได้รับการอนุโลมแล้ว"
          : j.error === "date_out_of_range" ? "เลือกวันที่ได้เฉพาะย้อนหลังไม่เกิน 45 วัน"
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
        <h2 className="font-bold text-slate-800 text-sm">ยื่นคำขออนุโลม</h2>
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="label">วันที่มาสาย</label>
            <input type="date" className="input" value={date} max={today}
              onChange={(e) => setDate(e.target.value)} disabled={busy} />
          </div>
        </div>
        <div>
          <label className="label">เหตุผล</label>
          <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
            disabled={busy} placeholder="เช่น เลิกเรียนช้า / ติดประชุมด่วน / รถติดจากเหตุสุดวิสัย" maxLength={500} />
        </div>
        {msg && <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-rose-600"}`}>{msg.text}</p>}
        <div className="flex justify-end">
          <button type="button" disabled={busy || reason.trim().length < 3} onClick={submit}
            className="text-sm px-4 py-2 rounded-lg bg-brand text-white font-medium disabled:opacity-40">
            {busy ? "กำลังส่ง…" : "ส่งคำขอ"}
          </button>
        </div>
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
                <th className="py-2 pr-3">สาย(นาที)</th>
                <th className="py-2 pr-3">เหตุผล</th>
                <th className="py-2 pr-3">สถานะ</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 last:border-0 align-top">
                  <td className="py-2 pr-3 whitespace-nowrap tabular-nums text-slate-700">{r.work_date}</td>
                  <td className="py-2 pr-3 tabular-nums text-slate-600">{r.late_minutes > 0 ? r.late_minutes : "—"}</td>
                  <td className="py-2 pr-3 text-slate-600">
                    {r.reason}
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
