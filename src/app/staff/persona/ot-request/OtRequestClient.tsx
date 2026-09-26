"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { BackdateDay } from "@/lib/ot-backdate";

const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "รออนุมัติ", cls: "bg-amber-100 text-amber-700" },
  approved: { label: "อนุมัติแล้ว", cls: "bg-emerald-100 text-emerald-700" },
  rejected: { label: "ไม่อนุมัติ", cls: "bg-rose-100 text-rose-700" },
};

function StatusPill({ status }: { status: string | null }) {
  if (!status || !STATUS[status]) return <span className="text-slate-400">—</span>;
  const s = STATUS[status];
  return <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${s.cls}`}>{s.label}</span>;
}

const hhmm = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

export default function OtRequestClient({ days, hasActiveBranch }: { days: BackdateDay[]; hasActiveBranch: boolean }) {
  const router = useRouter();
  const [selDate, setSelDate] = useState(days[0]?.date ?? "");
  const selected = useMemo(() => days.find((d) => d.date === selDate) ?? null, [days, selDate]);

  const [late, setLate] = useState("");
  const [early, setEarly] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Prefill when the picked day changes (existing request wins, else the shift).
  const [primed, setPrimed] = useState<string | null>(null);
  if (selected && primed !== selected.date) {
    setPrimed(selected.date);
    // Prefill with the real clocked times (an existing request wins): the actual
    // clock-out is the true late-end; the clock-in prefills early only when it
    // beat the scheduled start.
    setLate(selected.requestedUntil ?? selected.actualOut ?? selected.scheduledEnd ?? "");
    const earlyPrefill = selected.requestedFrom
      ?? (selected.actualIn && selected.scheduledStart && selected.actualIn < selected.scheduledStart ? selected.actualIn : "");
    setEarly(earlyPrefill);
    setMsg(null);
  }

  async function submit() {
    if (!selDate || !late) { setMsg({ ok: false, text: "เลือกวันและกรอกเวลาที่อยู่เกินเวลาก่อน" }); return; }
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/persona/ot-requests/backdate"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ work_date: selDate, requested_until: late, requested_from: early.trim() || null }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        setMsg({ ok: true, text: "ส่งคำขอ OT ย้อนหลังแล้ว รอหัวหน้าอนุมัติ" });
        router.refresh();
      } else {
        setMsg({ ok: false, text: j.message ?? (j.error === "not_backdated" ? "หน้านี้สำหรับขอย้อนหลังเท่านั้น" : "ส่งคำขอไม่สำเร็จ ลองใหม่อีกครั้ง") });
      }
    } catch {
      setMsg({ ok: false, text: "เชื่อมต่อไม่ได้ ลองใหม่อีกครั้ง" });
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <h2 className="font-bold text-slate-800 text-sm">ยื่นขอ OT ย้อนหลัง</h2>
        {!hasActiveBranch ? (
          <p className="text-sm text-slate-500">ยังไม่ได้เลือกสาขา — กรุณาลงเวลาเข้างานก่อน</p>
        ) : days.length === 0 ? (
          <p className="text-sm text-slate-500">ยังไม่มีวันที่ขอย้อนหลังได้ — ต้องเป็นวันที่ลงเวลาทำงานจริงและอยู่ในรอบเงินเดือนที่ยังไม่ปิด</p>
        ) : (
          <>
            <div>
              <label className="label">วันที่ทำงาน</label>
              <select className="input" value={selDate} onChange={(e) => setSelDate(e.target.value)} disabled={busy}>
                {days.map((d) => (
                  <option key={d.date} value={d.date}>
                    {d.date}{d.scheduledStart && d.scheduledEnd ? ` · กะ ${d.scheduledStart}–${d.scheduledEnd}` : ""} · ทำงาน {hhmm(d.workedMinutes)} ชม.
                  </option>
                ))}
              </select>
            </div>
            {selected && (
              <p className="text-[11px] text-slate-500 -mt-1">
                กะที่ลงไว้ {selected.scheduledStart ?? "—"}–{selected.scheduledEnd ?? "—"} · ลงเวลาทำงานจริง {hhmm(selected.workedMinutes)} ชม.
              </p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">อยู่เกินเวลาถึง <span className="text-rose-500">*</span></label>
                <input type="time" step={900} className="input" value={late} onChange={(e) => setLate(e.target.value)} disabled={busy} />
                <p className="text-[10px] text-slate-400 mt-0.5">เวลาที่เลิกงานจริง (หลังเวลาเลิกกะ)</p>
              </div>
              <div>
                <label className="label">มาก่อนเวลาตั้งแต่ (ถ้ามี)</label>
                <input type="time" step={900} className="input" value={early} onChange={(e) => setEarly(e.target.value)} disabled={busy} />
                <p className="text-[10px] text-slate-400 mt-0.5">เวลาที่เข้างานจริง (ก่อนเวลาเข้ากะ)</p>
              </div>
            </div>
            {msg && <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-rose-600"}`}>{msg.text}</p>}
            <div className="flex justify-end">
              <button type="button" disabled={busy || !selDate || !late} onClick={submit}
                className="text-sm px-4 py-2 rounded-lg bg-brand text-white font-medium disabled:opacity-40">
                {busy ? "กำลังส่ง…" : "ส่งคำขอ OT"}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="card overflow-x-auto">
        <h2 className="font-bold text-slate-800 text-sm mb-2">วันทำงานในรอบที่ยังเปิด</h2>
        {days.length === 0 ? (
          <p className="text-sm text-slate-400 py-4 text-center">ไม่มีข้อมูล</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                <th className="py-2 pr-3">วันที่</th>
                <th className="py-2 pr-3">กะ</th>
                <th className="py-2 pr-3">OT ที่ขอ</th>
                <th className="py-2 pr-3">สถานะ</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.date} className="border-b border-slate-100 last:border-0 align-top">
                  <td className="py-2 pr-3 whitespace-nowrap tabular-nums text-slate-700">{d.date}</td>
                  <td className="py-2 pr-3 whitespace-nowrap tabular-nums text-slate-500">{d.scheduledStart ?? "—"}–{d.scheduledEnd ?? "—"}</td>
                  <td className="py-2 pr-3 whitespace-nowrap tabular-nums text-slate-600">
                    {d.requestedFrom && <span>เข้า {d.requestedFrom} </span>}
                    {d.requestedUntil ? <span>ออก {d.requestedUntil}</span> : (!d.requestedFrom && "—")}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap space-x-1">
                    {d.requestedUntil && <StatusPill status={d.status} />}
                    {d.requestedFrom && <StatusPill status={d.earlyStatus} />}
                    {!d.requestedUntil && !d.requestedFrom && <span className="text-slate-400">ยังไม่ได้ขอ</span>}
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
