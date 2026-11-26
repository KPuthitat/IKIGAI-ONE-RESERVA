"use client";

import { createContext, useContext, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

type Ref = { id: number; name: string };
type Result = { id: number; status: "moved" | "same_branch" | "not_found" | "blocked"; reason?: string; from?: string | null };
type Move = { id: number; kind: string; row_id: number; from_name: string | null; to_name: string; summary: string | null; reason: string | null; by_name: string; moved_at: string };

/** Tick boxes on a list, then move the ticked rows to another branch in one go. The list reloads itself through onDone. */
export function useSelection() {
  const [sel, setSel] = useState<number[]>([]);
  return { sel, toggle: (id: number) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id])), clear: () => setSel([]), has: (id: number) => sel.includes(id) };
}

export function PickBox({ id, sel, toggle }: { id: number; sel: number[]; toggle: (id: number) => void }) {
  return (
    <label className="inline-flex items-center justify-center min-h-[44px] min-w-[32px] cursor-pointer" title="เลือกเพื่อย้ายสาขา">
      <input type="checkbox" className="h-4 w-4" checked={sel.includes(id)} onChange={() => toggle(id)} aria-label="เลือกรายการเพื่อย้ายสาขา" />
    </label>
  );
}

export function MoveBar({ kind, sel, clear, branches, currentBranchId, onDone }: { kind: "expense" | "income"; sel: number[]; clear: () => void; branches: Ref[]; currentBranchId: number | null; onDone: () => void | Promise<void> }) {
  const targets = branches.filter((b) => b.id !== currentBranchId);
  const [to, setTo] = useState<string>("");
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ ok: boolean; text: string; blocked: Result[] } | null>(null);
  if (sel.length === 0 && !res) return null;
  const toName = targets.find((b) => String(b.id) === to)?.name ?? "";

  async function go() {
    if (!to) return;
    if (!window.confirm(`ย้าย ${sel.length} รายการไปสาขา ${toName} ใช่หรือไม่?\nวันที่ ยอด และเอกสารเดิมไม่เปลี่ยน ย้ายกลับได้ภายหลัง`)) return;
    setBusy(true); setRes(null);
    try {
      const r = await fetch(apiUrl("/api/accounta/move-branch"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, ids: sel, toBranchId: Number(to), reason: reason.trim() || null, pin }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setRes({ ok: false, text: j.message ?? "ย้ายไม่สำเร็จ", blocked: [] }); setBusy(false); return; }
      const results = j.results as Result[];
      const blocked = results.filter((x) => x.status === "blocked" || x.status === "not_found");
      setRes({ ok: true, text: `ย้ายแล้ว ${j.moved} รายการไปสาขา ${toName}${blocked.length ? ` · ย้ายไม่ได้ ${blocked.length} รายการ` : ""}`, blocked });
      clear(); setReason(""); setPin(""); await onDone();
    } catch { setRes({ ok: false, text: "เชื่อมต่อไม่สำเร็จ ลองอีกครั้ง", blocked: [] }); }
    setBusy(false);
  }

  return (
    <div className="card border-brand/40 bg-amber-50/60 space-y-2 sticky top-2 z-20">
      {sel.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <b className="text-sm text-slate-800">เลือกแล้ว {sel.length} รายการ</b>
          <span className="text-sm text-slate-600">ย้ายไปสาขา</span>
          <select className="input min-h-[44px]" value={to} onChange={(e) => setTo(e.target.value)} aria-label="สาขาปลายทาง"><option value="">— เลือกสาขา —</option>{targets.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          <input className="input min-h-[44px] flex-1 min-w-[140px]" placeholder="เหตุผล (ไม่บังคับ) เช่น ลงผิดสาขา" value={reason} onChange={(e) => setReason(e.target.value)} />
          <input className="input min-h-[44px] w-28 text-center tracking-widest" type="password" inputMode="numeric" maxLength={4} placeholder="PIN" aria-label="PIN ยืนยันการย้าย" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
          <button type="button" className="btn-primary min-h-[44px] px-4" disabled={busy || !to || pin.length !== 4} onClick={go}>{busy ? "กำลังย้าย…" : "ย้ายสาขา"}</button>
          <button type="button" className="btn-secondary min-h-[44px] px-3" disabled={busy} onClick={clear}>ยกเลิกการเลือก</button>
        </div>
      )}
      {res && (
        <div role="status" className={`text-sm ${res.ok ? "text-emerald-800" : "text-rose-700"}`}>{res.text}
          {res.blocked.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-slate-700">{res.blocked.map((b) => <li key={b.id}>รายการ #{b.id}: {b.status === "not_found" ? "ไม่พบรายการ" : b.reason}</li>)}</ul>}
          <button type="button" className="ml-2 underline text-xs min-h-[44px]" onClick={() => setRes(null)}>ปิด</button>
        </div>
      )}
    </div>
  );
}

export function MoveHistory() {
  const [rows, setRows] = useState<Move[] | null>(null);
  const when = (s: string) => new Date(s.replace(" ", "T") + "Z").toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
  return (
    <details className="card text-sm" onToggle={async (e) => { if ((e.target as HTMLDetailsElement).open && !rows) { try { const j = await (await fetch(apiUrl("/api/accounta/move-branch?limit=40"))).json(); if (j.ok) setRows(j.moves); } catch { /* ignore */ } } }}>
      <summary className="cursor-pointer min-h-[44px] flex items-center font-semibold text-slate-700">ประวัติการย้ายสาขา</summary>
      {rows == null ? <p className="text-slate-500 py-2">กำลังโหลด…</p> : rows.length === 0 ? <p className="text-slate-500 py-2">ยังไม่เคยย้าย</p> : (
        <ul className="divide-y divide-slate-100">{rows.map((m) => <li key={m.id} className="py-1.5"><span className="text-xs text-slate-500">{when(m.moved_at)} · {m.by_name}</span><br />{m.kind === "expense" ? "รายจ่าย" : "รายรับ"} {m.summary} — {m.from_name ?? "—"} → <b>{m.to_name}</b>{m.reason ? <span className="text-slate-500"> ({m.reason})</span> : null}</li>)}</ul>
      )}
    </details>
  );
}


// ── move ONE row from where it is shown (daybook) — same rules, PIN every time, always in the move history ──
type MoveTarget = { kind: "expense" | "income"; id: number; summary: string };
const MoveCtx = createContext<((t: MoveTarget) => void) | null>(null);
/** Rows call this to open the "ย้ายสาขา" dialog; null outside a MoveRowProvider (the button is then simply not shown). */
export const useMoveRow = () => useContext(MoveCtx);

export function MoveRowProvider({ branches, currentBranchId, children }: { branches: Ref[]; currentBranchId: number | null; children: React.ReactNode }) {
  const router = useRouter();
  const [t, setT] = useState<MoveTarget | null>(null);
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const targets = branches.filter((b) => b.id !== currentBranchId);
  const close = () => { setT(null); setTo(""); setReason(""); setPin(""); setErr(null); };

  async function go() {
    if (!t || !to) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(apiUrl("/api/accounta/move-branch"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: t.kind, ids: [t.id], toBranchId: Number(to), reason: reason.trim() || null, pin }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setErr(j.message ?? "ย้ายไม่สำเร็จ"); setPin(""); setBusy(false); return; }
      const res = (j.results as Result[])[0];
      if (res.status !== "moved") { setErr(res.status === "blocked" ? res.reason ?? "ย้ายรายการนี้ไม่ได้" : res.status === "same_branch" ? "รายการอยู่สาขานี้แล้ว" : "ไม่พบรายการ"); setBusy(false); return; }
      setDone(`ย้ายแล้ว: ${t.summary} → ${targets.find((b) => String(b.id) === to)?.name ?? ""} (บันทึกในประวัติการย้ายแล้ว)`);
      close(); router.refresh();
    } catch { setErr("เชื่อมต่อไม่สำเร็จ ลองอีกครั้ง"); }
    setBusy(false);
  }

  return (
    <MoveCtx.Provider value={setT}>
      {children}
      {done && <div role="status" className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 max-w-[92vw] rounded-xl bg-emerald-700 text-white text-sm px-4 py-2 shadow-lg">{done}<button type="button" className="ml-3 underline min-h-[44px]" onClick={() => setDone(null)}>ปิด</button></div>}
      {t && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-3" role="dialog" aria-modal="true" aria-label="ย้ายสาขา">
          <div className="w-full max-w-md bg-white rounded-2xl p-4 space-y-3 shadow-xl">
            <div className="font-bold text-slate-800">ย้ายสาขา · {t.kind === "expense" ? "รายจ่าย" : "รายรับ"}</div>
            <div className="text-sm text-slate-600 break-words">{t.summary}</div>
            <p className="text-xs text-slate-500">วันที่ ยอด และเอกสารเดิมไม่เปลี่ยน ย้ายกลับได้ภายหลัง และทุกการย้ายถูกบันทึกในประวัติ (ใครย้าย เมื่อไร จากไหนไปไหน)</p>
            <label className="block text-sm"><span className="label">ย้ายไปสาขา</span>
              <select className="input w-full min-h-[44px]" value={to} onChange={(e) => setTo(e.target.value)}><option value="">— เลือกสาขา —</option>{targets.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
            <label className="block text-sm"><span className="label">เหตุผล (ไม่บังคับ)</span><input className="input w-full min-h-[44px]" maxLength={300} placeholder="เช่น ลงผิดสาขา" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
            <label className="block text-sm"><span className="label">PIN ของท่าน (ยืนยันการย้าย)</span>
              <input className="input w-full min-h-[44px] text-center tracking-widest" type="password" inputMode="numeric" maxLength={4} autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} onKeyDown={(e) => { if (e.key === "Enter" && to && pin.length === 4 && !busy) go(); }} /></label>
            {err && <div role="alert" className="text-sm text-rose-700">{err}</div>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary min-h-[44px] px-4" onClick={close} disabled={busy}>ยกเลิก</button>
              <button type="button" className="btn-primary min-h-[44px] px-5" disabled={busy || !to || pin.length !== 4} onClick={go}>{busy ? "กำลังย้าย…" : "ย้ายสาขา"}</button>
            </div>
          </div>
        </div>
      )}
    </MoveCtx.Provider>
  );
}

/** The small "ย้าย" link a row shows next to แก้ไข / ลบออก. */
export function MoveLink({ kind, id, summary }: { kind: "expense" | "income"; id: number; summary: string }) {
  const open = useMoveRow();
  if (!open) return null;
  return <button type="button" onClick={() => open({ kind, id, summary })} className="text-[11px] text-slate-500 hover:text-brand mr-2 underline-offset-2 hover:underline" title="ย้ายไปสาขาอื่น (ต้องใส่ PIN)">ย้ายสาขา</button>;
}
