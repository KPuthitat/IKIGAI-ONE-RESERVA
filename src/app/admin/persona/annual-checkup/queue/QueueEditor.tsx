"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

type Row = { key: string; label: string; code: string | null; payer: string | null; queue_no: number; appt_time: string | null; arrived: boolean };

export default function QueueEditor({ roundId, roundName, defaultTime, rows }: { roundId: number; roundName: string; defaultTime: string | null; rows: Row[] }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Record<string, { no: string; time: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const val = (r: Row) => draft[r.key] ?? { no: String(r.queue_no), time: r.appt_time ?? "" };
  const dirty = (r: Row) => { const v = val(r); return v.no !== String(r.queue_no) || v.time !== (r.appt_time ?? ""); };
  const save = async (r: Row) => {
    const v = val(r);
    setBusy(r.key); setMsg(null);
    try {
      const j = await (await fetch(apiUrl("/api/admin/persona/annual-checkup/queue"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roundId, subject: r.key, queueNo: Number(v.no), apptTime: v.time || null }) })).json();
      setMsg(j.ok ? { ok: true, text: `บันทึกแล้ว: ${r.label}` } : { ok: false, text: j.message ?? "บันทึกไม่สำเร็จ" });
      if (j.ok) { setDraft((d) => { const n = { ...d }; delete n[r.key]; return n; }); router.refresh(); }
    } catch { setMsg({ ok: false, text: "เชื่อมต่อไม่สำเร็จ ลองอีกครั้ง" }); }
    setBusy(null);
  };
  return (
    <div className="card overflow-x-auto space-y-2">
      <div className="text-sm font-semibold text-slate-800">{roundName} · {rows.length} คน{defaultTime ? ` · เวลานัดเริ่มต้น ${defaultTime} น.` : ""}</div>
      {msg && <div className={`rounded-lg px-3 py-2 text-sm border ${msg.ok ? "bg-emerald-50 text-emerald-800 border-emerald-200" : "bg-rose-50 text-rose-800 border-rose-200"}`}>{msg.text}</div>}
      <table className="w-full text-sm min-w-[560px]">
        <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-200"><th className="py-1 pr-3">ลำดับ</th><th className="py-1 pr-3">ชื่อ</th><th className="py-1 pr-3">เวลานัด (เว้นว่าง = ใช้เวลาเริ่มต้น)</th><th className="py-1" /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-slate-100 last:border-0">
              <td className="py-1.5 pr-3"><input className="input w-20" inputMode="numeric" value={val(r).no} onChange={(e) => setDraft((d) => ({ ...d, [r.key]: { ...val(r), no: e.target.value.replace(/\D/g, "") } }))} aria-label={`ลำดับของ ${r.label}`} /></td>
              <td className="py-1.5 pr-3"><div className="font-medium text-slate-800">{r.label}{r.arrived && <span className="ml-2 rounded px-1.5 py-0.5 text-[11px] bg-emerald-100 text-emerald-700">มาแล้ว</span>}</div><div className="text-[11px] text-slate-400">{r.code ?? "ผู้เข้าตรวจภายนอก"} · {r.payer ?? "—"}</div></td>
              <td className="py-1.5 pr-3"><input type="time" className="input w-32" value={val(r).time} onChange={(e) => setDraft((d) => ({ ...d, [r.key]: { ...val(r), time: e.target.value } }))} /></td>
              <td className="py-1.5"><button type="button" className="btn-primary text-xs" disabled={!dirty(r) || busy === r.key || !val(r).no} onClick={() => save(r)}>บันทึก</button></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={4} className="py-3 text-slate-500">ยังไม่มีลำดับ — นำเข้าไฟล์ Excel ที่มีคอลัมน์ “ลำดับ” ก่อน</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
