"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { ShiftRequestRow, ShiftRequestLabels } from "@/lib/shift-requests";
import { useConfirm } from "@/app/components/useConfirm";

type PositionOpt = { id: number; title: string };
type ShiftOpt = { id: number; code: string; name: string | null };

const KIND_TH: Record<string, string> = { extra_shift: "ขอเพิ่มกะ", swap: "ขอสลับวันหยุด" };
const STATUS_TH: Record<string, { t: string; c: string }> = {
  pending: { t: "รออนุมัติ", c: "bg-amber-100 text-amber-700" },
  approved: { t: "อนุมัติแล้ว", c: "bg-emerald-100 text-emerald-700" },
  rejected: { t: "ไม่อนุมัติ", c: "bg-rose-100 text-rose-700" },
  cancelled: { t: "ยกเลิกแล้ว", c: "bg-slate-100 text-slate-500" }
};
function todayBkk(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}

export default function ShiftRequestClient({
  requests, positions, shiftCodes
}: {
  requests: Array<ShiftRequestRow & Partial<ShiftRequestLabels>>;
  positions: PositionOpt[];
  shiftCodes: ShiftOpt[];
}) {
  const router = useRouter();
  const { confirm, ConfirmDialog } = useConfirm();
  const [kind, setKind] = useState<"extra_shift" | "swap">("extra_shift");
  const [workDate, setWorkDate] = useState("");
  const [offDate, setOffDate] = useState("");
  const [positionId, setPositionId] = useState<number | "">("");
  const [shiftCodeId, setShiftCodeId] = useState<number | "">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function submit() {
    if (!workDate) { setMsg({ kind: "err", text: "เลือกวันที่ต้องการทำงานเพิ่ม" }); return; }
    if (kind === "swap" && !offDate) { setMsg({ kind: "err", text: "เลือกวันที่ต้องการหยุด" }); return; }
    if (kind === "extra_shift" && (positionId === "" || shiftCodeId === "")) {
      setMsg({ kind: "err", text: "เลือกตำแหน่งและเวลาที่ต้องการทำงาน" }); return;
    }
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/persona/shift-request"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind, work_date: workDate,
          off_date: kind === "swap" ? offDate : null,
          position_id: kind === "extra_shift" ? positionId : undefined,
          shift_code_id: kind === "extra_shift" ? shiftCodeId : undefined,
          note: note.trim() || undefined
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setMsg({ kind: "err", text: j.message || "ส่งคำขอไม่สำเร็จ ลองใหม่อีกครั้ง" }); return; }
      setMsg({ kind: "ok", text: `ส่งคำขอแล้ว (${j.ref_no}) — รอหัวหน้าอนุมัติ` });
      setWorkDate(""); setOffDate(""); setNote(""); setPositionId(""); setShiftCodeId("");
      router.refresh();
    } finally { setBusy(false); }
  }

  async function cancel(id: number) {
    const ok = await confirm({ title: "ยกเลิกคำขอนี้?", confirmLabel: "ยกเลิกคำขอ", cancelLabel: "ปิด", variant: "warning" });
    if (ok === null) return;
    const res = await fetch(apiUrl(`/api/persona/shift-request/${id}/cancel`), { method: "POST" });
    if (res.ok) router.refresh();
  }

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      {ConfirmDialog}
      <div>
        <h1 className="text-xl font-bold text-slate-800">คำขอเปลี่ยนเวลางาน</h1>
        <p className="text-sm text-slate-500">
          ขอเพิ่มกะทำงาน หรือขอสลับวันหยุด (หยุดวันหนึ่งแล้วทำงานชดเชยอีกวัน โดยไม่เสียวันลา) —
          หัวหน้างานอนุมัติ แล้วแอดมินจะจัดลงตารางให้
        </p>
      </div>

      <div className="card space-y-3">
        <div>
          <label className="label">ประเภทคำขอ</label>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as "extra_shift" | "swap")}>
            <option value="extra_shift">ขอเพิ่มกะ (ทำงานเพิ่มอีกวัน)</option>
            <option value="swap">ขอสลับวันหยุด (หยุดวันหนึ่ง ทำงานชดเชยอีกวัน)</option>
          </select>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">วันที่ขอทำงานเพิ่ม</label>
            <input type="date" className="input" value={workDate} min={todayBkk()}
              onChange={(e) => setWorkDate(e.target.value)} />
          </div>
          {kind === "swap" && (
            <div>
              <label className="label">วันที่ขอหยุดแทน</label>
              <input type="date" className="input" value={offDate} min={todayBkk()}
                onChange={(e) => setOffDate(e.target.value)} />
            </div>
          )}
        </div>
        {kind === "extra_shift" && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">ตำแหน่ง</label>
              <select className="input" value={positionId}
                onChange={(e) => setPositionId(e.target.value === "" ? "" : Number(e.target.value))}>
                <option value="">— เลือกตำแหน่ง —</option>
                {positions.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
              </select>
            </div>
            <div>
              <label className="label">เวลา (กะ)</label>
              <select className="input" value={shiftCodeId}
                onChange={(e) => setShiftCodeId(e.target.value === "" ? "" : Number(e.target.value))}>
                <option value="">— เลือกเวลา —</option>
                {shiftCodes.map((s) => <option key={s.id} value={s.id}>{s.code}{s.name ? ` · ${s.name}` : ""}</option>)}
              </select>
            </div>
            {(positions.length === 0 || shiftCodes.length === 0) && (
              <p className="sm:col-span-2 text-xs text-amber-600">
                สาขานี้ยังไม่มีตำแหน่ง/กะให้เลือก — แจ้งแอดมินตั้งค่าตารางงานก่อน
              </p>
            )}
          </div>
        )}
        <div>
          <label className="label">เหตุผล / หมายเหตุ</label>
          <textarea className="input text-sm" rows={2} value={note} maxLength={500}
            onChange={(e) => setNote(e.target.value)} placeholder="เช่น อยากได้ชั่วโมงเพิ่ม / ติดธุระวันนั้น" />
        </div>
        {msg && <p className={`text-sm ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>{msg.text}</p>}
        <button type="button" onClick={submit} disabled={busy} className="btn-primary w-full py-2.5 disabled:opacity-50">
          {busy ? "กำลังส่ง…" : "ส่งคำขอ"}
        </button>
      </div>

      <div className="card space-y-2">
        <h2 className="font-bold text-slate-800 text-sm">คำขอของฉัน</h2>
        {requests.length === 0 ? (
          <p className="text-xs text-slate-400">ยังไม่มีคำขอ</p>
        ) : requests.map((r) => {
          const st = STATUS_TH[r.status] ?? STATUS_TH.pending;
          return (
            <div key={r.id} className="text-sm border-b border-slate-100 last:border-0 pb-2 flex items-start justify-between gap-2">
              <div>
                <div className="font-medium text-slate-800">
                  {KIND_TH[r.kind]} <span className="font-mono text-[11px] text-slate-400">{r.ref_no}</span>
                </div>
                <div className="text-xs text-slate-500">
                  {r.kind === "swap"
                    ? `หยุด ${r.off_date} · ทำงานแทน ${r.work_date}`
                    : `ทำงานเพิ่ม ${r.work_date}`}
                  {r.kind === "extra_shift" && (r.position_title || r.shift_code) && (
                    <> · {r.position_title ?? "—"}{r.shift_code ? ` · ${r.shift_code}` : ""}</>
                  )}
                </div>
                {r.decision_note && <div className="text-[11px] text-slate-400 mt-0.5">หมายเหตุ: {r.decision_note}</div>}
              </div>
              <div className="flex flex-col items-end gap-1 whitespace-nowrap">
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${st.c}`}>{st.t}</span>
                {r.status === "pending" && (
                  <button type="button" onClick={() => cancel(r.id)} className="text-[11px] text-rose-600 hover:underline">ยกเลิก</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
