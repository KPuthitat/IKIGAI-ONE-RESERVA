"use client";

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/url";

type T = { id: number; memoId: number; memoNo: string; subject: string; fromName: string; toName: string; weekStart: string | null; amount: number; status: "awaiting" | "transferred" | "cancelled"; transferredOn: string | null; actualAmount: number | null; transferredByName: string | null; note: string; autoLinked: boolean };
type Fund = { accountId: number; name: string; tracked: boolean; received: number; committed: number; remaining: number };
const baht = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

async function call(method: string, body?: unknown): Promise<{ ok: boolean; j: Record<string, unknown> }> {
  try { const r = await fetch(apiUrl("/api/admin/accounta/funding"), { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); return { ok: r.ok && j.ok !== false, j }; }
  catch { return { ok: false, j: { message: "เชื่อมต่อไม่สำเร็จ" } }; }
}

export default function FundingClient() {
  const [d, setD] = useState<{ awaiting: T[]; history: T[]; funds: Fund[] } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [rec, setRec] = useState<T | null>(null);
  const load = useCallback(async () => { const r = await call("GET"); if (r.ok) setD(r.j as never); else setMsg({ ok: false, text: (r.j.message as string) ?? "โหลดไม่สำเร็จ" }); }, []);
  useEffect(() => { load(); }, [load]);
  if (!d) return <div className="card text-sm text-slate-500">กำลังโหลด…</div>;
  return (
    <div className="space-y-4">
      {msg && <div role="status" className={`rounded-lg px-4 py-2 text-sm border ${msg.ok ? "bg-emerald-50 text-emerald-800 border-emerald-200" : "bg-rose-50 text-rose-800 border-rose-200"}`}>{msg.text}</div>}

      {d.funds.length > 0 && (
        <section className="grid gap-3 sm:grid-cols-2" aria-label="เงินในบัญชีที่รับโอน">
          {d.funds.map((f) => (
            <div key={f.accountId} className="card space-y-1">
              <div className="font-semibold text-slate-800 break-words">{f.name}</div>
              <div className="text-xs text-slate-500">รับโอนแล้ว ฿{baht(f.received)} · PR ที่อนุมัติแล้ว ฿{baht(f.committed)}</div>
              <div className={`text-xl font-bold tabular-nums ${f.remaining < 0 ? "text-rose-700" : "text-slate-900"}`}>คงเหลือสำหรับซื้อ ฿{baht(f.remaining)}</div>
            </div>
          ))}
        </section>
      )}

      <section className="space-y-2" aria-label="รอโอน">
        <h2 className="font-bold text-slate-800">รอโอน ({d.awaiting.length})</h2>
        {d.awaiting.length === 0 ? <div className="card text-sm text-slate-500 text-center py-6">ไม่มีรายการรอโอน</div> : (
          <ul className="space-y-2">{d.awaiting.map((t) => (
            <li key={t.id} className="card !p-4 space-y-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0"><div className="font-semibold break-words">{t.subject}</div><div className="text-xs text-slate-500">{t.memoNo} · {t.fromName} → {t.toName}{t.weekStart ? ` · สัปดาห์เริ่ม ${t.weekStart}` : ""}</div></div>
                <div className="text-lg font-bold tabular-nums">฿{baht(t.amount)}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-primary min-h-[44px] px-4 text-sm" onClick={() => setRec(t)}>บันทึกว่าโอนแล้ว</button>
                <a className="btn-secondary min-h-[44px] px-4 text-sm inline-flex items-center" href={apiUrl(`/admin/memos?id=${t.memoId}`)}>ดู Memo</a>
                <button type="button" className="min-h-[44px] px-4 rounded-xl border border-rose-300 text-rose-700 text-sm" onClick={async () => { if (!window.confirm("ยกเลิกรายการโอนนี้?")) return; const r = await call("POST", { action: "cancel", id: t.id }); setMsg({ ok: r.ok, text: r.ok ? "ยกเลิกแล้ว" : (r.j.message as string) ?? "ไม่สำเร็จ" }); await load(); }}>ยกเลิก</button>
              </div>
            </li>))}</ul>
        )}
      </section>

      {rec && <RecordForm t={rec} onClose={() => setRec(null)} onDone={async (text) => { setRec(null); setMsg({ ok: true, text }); await load(); }} />}

      <section className="space-y-2" aria-label="ประวัติ">
        <h2 className="font-bold text-slate-800">ประวัติ</h2>
        {d.history.length === 0 ? <div className="text-sm text-slate-500">ยังไม่มีประวัติ</div> : (
          <ul className="space-y-1.5">{d.history.map((t) => (
            <li key={t.id} className="card !p-3 flex flex-wrap items-center justify-between gap-2 text-sm">
              <div className="min-w-0"><div className="font-medium break-words">{t.subject} <span className="text-xs text-slate-400">{t.memoNo}</span></div>
                <div className="text-xs text-slate-500">{t.fromName} → {t.toName} · {t.status === "cancelled" ? "ยกเลิก" : `โอนเมื่อ ${t.transferredOn}${t.autoLinked ? " (ระบบจับคู่จาก statement)" : t.transferredByName ? ` โดย ${t.transferredByName}` : ""}`}{t.note ? ` · ${t.note}` : ""}</div></div>
              <div className="tabular-nums font-semibold">฿{baht(t.actualAmount ?? t.amount)}{t.actualAmount != null && t.actualAmount !== t.amount && <span className="block text-[11px] text-amber-700 font-normal">อนุมัติ ฿{baht(t.amount)}</span>}</div>
            </li>))}</ul>
        )}
      </section>
    </div>
  );
}

function RecordForm({ t, onClose, onDone }: { t: T; onClose: () => void; onDone: (text: string) => void }) {
  const [on, setOn] = useState(today());
  const [amt, setAmt] = useState(String(t.amount));
  const [note, setNote] = useState("");
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <section className="card space-y-3 border-2 border-brand/30" aria-label="บันทึกการโอน">
      <h3 className="font-bold text-slate-800 break-words">บันทึกการโอน — {t.subject}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm"><span className="label">วันที่โอน</span><input type="date" className="input w-full min-h-[44px]" value={on} onChange={(e) => setOn(e.target.value)} /></label>
        <label className="block text-sm"><span className="label">ยอดที่โอนจริง (บาท)</span><input className="input w-full min-h-[44px] text-right" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^\d.]/g, ""))} /></label>
        <label className="block text-sm sm:col-span-2"><span className="label">หมายเหตุ</span><input className="input w-full min-h-[44px]" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      {Number(amt) !== t.amount && <p className="text-xs text-amber-800">ยอดไม่ตรงกับที่อนุมัติ (฿{baht(t.amount)}) — ระบบใช้ยอดที่โอนจริงเป็นเงินที่ฝั่งจัดซื้อมีให้ใช้</p>}
      <div className="flex flex-wrap items-center gap-2">
        <input className="input w-32 min-h-[44px] text-center tracking-widest" inputMode="numeric" type="password" maxLength={4} placeholder="PIN 4 หลัก" aria-label="PIN" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
        <button type="button" className="btn-primary min-h-[44px] px-5" disabled={busy || pin.length !== 4 || !(Number(amt) > 0)} onClick={async () => {
          setBusy(true); setErr("");
          const r = await call("POST", { action: "record", id: t.id, transferredOn: on, actualAmount: Number(amt), note, pin });
          setBusy(false);
          if (r.ok) onDone("บันทึกการโอนแล้ว"); else setErr((r.j.message as string) ?? "ไม่สำเร็จ");
        }}>ยืนยัน</button>
        <button type="button" className="btn-secondary min-h-[44px] px-4" onClick={onClose}>ปิด</button>
      </div>
      {err && <p className="text-sm text-rose-700" role="alert">{err}</p>}
    </section>
  );
}
