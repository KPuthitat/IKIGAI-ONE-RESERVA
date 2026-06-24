"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { SwapRowWithNames, SwapCandidate } from "@/lib/shift-swap";

const STATUS_TH: Record<string, { t: string; c: string }> = {
  pending: { t: "รอตอบรับ", c: "bg-amber-100 text-amber-700" },
  accepted: { t: "สลับแล้ว", c: "bg-emerald-100 text-emerald-700" },
  declined: { t: "ปฏิเสธ", c: "bg-rose-100 text-rose-700" },
  cancelled: { t: "ยกเลิกแล้ว", c: "bg-slate-100 text-slate-500" }
};
function todayBkk(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}
const MY_SHIFT_REASON: Record<string, string> = {
  no_shift: "คุณไม่มีกะทำงานในวันนี้ — เลือกวันที่คุณมีกะ",
  multiple: "คุณมีหลายกะในวันนี้ — การสลับเองรองรับเฉพาะวันที่มีกะเดียว"
};

export default function SwapClient({ incoming, sent }: { incoming: SwapRowWithNames[]; sent: SwapRowWithNames[] }) {
  const router = useRouter();
  const [date, setDate] = useState(todayBkk());
  const [myShift, setMyShift] = useState<string | null>(null);
  const [myReason, setMyReason] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<SwapCandidate[]>([]);
  const [target, setTarget] = useState<number | "">("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    async function load() {
      if (!date) return;
      setLoading(true); setTarget("");
      try {
        const res = await fetch(apiUrl(`/api/persona/shift-swap?date=${date}`));
        const j = await res.json().catch(() => ({}));
        if (!live) return;
        if (res.ok && j.ok) { setMyShift(j.myShift); setMyReason(j.myShiftReason); setCandidates(j.candidates ?? []); }
        else { setMyShift(null); setMyReason(null); setCandidates([]); }
      } finally { if (live) setLoading(false); }
    }
    void load();
    return () => { live = false; };
  }, [date]);

  async function submit() {
    if (!target) { setMsg({ kind: "err", text: "เลือกเพื่อนที่จะสลับกะด้วย" }); return; }
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/persona/shift-swap"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, target_user_id: target, note: note.trim() || undefined })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setMsg({ kind: "err", text: j.message || "ส่งคำขอไม่สำเร็จ" }); return; }
      setMsg({ kind: "ok", text: `ส่งคำขอแล้ว (${j.ref_no}) — รอเพื่อนกดรับ` });
      setTarget(""); setNote("");
      router.refresh();
    } finally { setBusy(false); }
  }

  async function respond(id: number, action: "accept" | "decline") {
    if (action === "decline" && !window.confirm("ปฏิเสธคำขอสลับกะนี้?")) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/persona/shift-swap/${id}/respond`), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setMsg({ kind: "err", text: j.message || "ทำรายการไม่สำเร็จ" }); return; }
      setMsg({ kind: "ok", text: action === "accept" ? "สลับกะเรียบร้อย ✓ ตารางอัปเดตแล้ว" : "ปฏิเสธคำขอแล้ว" });
      router.refresh();
    } finally { setBusy(false); }
  }

  async function cancel(id: number) {
    if (!window.confirm("ยกเลิกคำขอนี้?")) return;
    const res = await fetch(apiUrl(`/api/persona/shift-swap/${id}/cancel`), { method: "POST" });
    if (res.ok) router.refresh();
  }

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      <div>
        <h1 className="text-xl font-bold text-slate-800">สลับกะ</h1>
        <p className="text-sm text-slate-500">
          สลับกะกับเพื่อนที่เข้างานวันเดียวกัน — เมื่อส่งคำขอแล้วเพื่อนต้องกดรับ ตารางถึงจะสลับให้
          อัตโนมัติ (ไม่ต้องให้แอดมินอนุมัติ)
        </p>
      </div>

      {/* Incoming — waiting for me to accept */}
      {incoming.length > 0 && (
        <div className="card space-y-2 ring-1 ring-amber-300/60">
          <h2 className="font-bold text-slate-800 text-sm">คำขอที่รอคุณตอบรับ ({incoming.length})</h2>
          {incoming.map((r) => (
            <div key={r.id} className="text-sm border-b border-slate-100 last:border-0 pb-2">
              <div className="font-medium text-slate-800">{r.initiator_name} ขอสลับกะ <span className="font-mono text-[11px] text-slate-400">{r.ref_no}</span></div>
              <div className="text-xs text-slate-500 mt-0.5">วันที่ {r.swap_date}</div>
              <div className="text-xs text-slate-600 mt-1">
                • กะของคุณ {r.target_shift} <span className="text-slate-400">→ จะเปลี่ยนเป็น</span> {r.initiator_shift}<br />
                • กะของ {r.initiator_name} {r.initiator_shift} <span className="text-slate-400">→ จะเปลี่ยนเป็น</span> {r.target_shift}
              </div>
              {r.note && <div className="text-[11px] text-slate-400 mt-0.5">หมายเหตุ: {r.note}</div>}
              <div className="flex gap-2 mt-2">
                <button type="button" onClick={() => respond(r.id, "accept")} disabled={busy} className="btn-primary text-sm px-4 py-1.5 disabled:opacity-50">กดรับ (สลับกะ)</button>
                <button type="button" onClick={() => respond(r.id, "decline")} disabled={busy} className="text-sm px-3 py-1.5 rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50">ปฏิเสธ</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Request form */}
      <div className="card space-y-3">
        <h2 className="font-bold text-slate-800 text-sm">ขอสลับกะ</h2>
        <div>
          <label className="label">วันที่</label>
          <input type="date" className="input" value={date} min={todayBkk()} onChange={(e) => setDate(e.target.value)} />
          {loading ? (
            <p className="text-[11px] text-slate-400 mt-1">กำลังโหลด…</p>
          ) : myShift ? (
            <p className="text-[11px] text-emerald-700 mt-1">กะของคุณวันนี้: {myShift}</p>
          ) : (
            <p className="text-[11px] text-rose-500 mt-1">{myReason ? MY_SHIFT_REASON[myReason] : "ไม่มีข้อมูลกะ"}</p>
          )}
        </div>
        {myShift && (
          <>
            <div>
              <label className="label">สลับกับ</label>
              {candidates.length === 0 ? (
                <p className="text-[11px] text-slate-400">ไม่มีเพื่อนที่เข้างานวันเดียวกัน (ที่สลับได้)</p>
              ) : (
                <select className="input" value={target} onChange={(e) => setTarget(e.target.value ? Number(e.target.value) : "")}>
                  <option value="">— เลือกเพื่อน —</option>
                  {candidates.map((c) => <option key={c.userId} value={c.userId}>{c.name} · {c.shiftLabel}</option>)}
                </select>
              )}
            </div>
            <div>
              <label className="label">หมายเหตุ (ถ้ามี)</label>
              <textarea className="input text-sm" rows={2} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="เช่น ติดธุระช่วงเช้า" />
            </div>
            {msg && <p className={`text-sm ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>{msg.text}</p>}
            <button type="button" onClick={submit} disabled={busy || !target} className="btn-primary w-full py-2.5 disabled:opacity-50">
              {busy ? "กำลังส่ง…" : "ส่งคำขอสลับกะ"}
            </button>
          </>
        )}
        {!myShift && msg && <p className={`text-sm ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>{msg.text}</p>}
      </div>

      {/* My sent requests */}
      <div className="card space-y-2">
        <h2 className="font-bold text-slate-800 text-sm">คำขอที่ฉันส่ง</h2>
        {sent.length === 0 ? (
          <p className="text-xs text-slate-400">ยังไม่มีคำขอ</p>
        ) : sent.map((r) => {
          const st = STATUS_TH[r.status] ?? STATUS_TH.pending;
          return (
            <div key={r.id} className="text-sm border-b border-slate-100 last:border-0 pb-2 flex items-start justify-between gap-2">
              <div>
                <div className="font-medium text-slate-800">สลับกับ {r.target_name} <span className="font-mono text-[11px] text-slate-400">{r.ref_no}</span></div>
                <div className="text-xs text-slate-500">วันที่ {r.swap_date} · กะคุณ {r.initiator_shift} ↔ {r.target_shift}</div>
              </div>
              <div className="flex flex-col items-end gap-1 whitespace-nowrap">
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${st.c}`}>{st.t}</span>
                {r.status === "pending" && <button type="button" onClick={() => cancel(r.id)} className="text-[11px] text-rose-600 hover:underline">ยกเลิก</button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
