"use client";

import { useState } from "react";
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
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ ok: boolean; text: string; blocked: Result[] } | null>(null);
  if (sel.length === 0 && !res) return null;
  const toName = targets.find((b) => String(b.id) === to)?.name ?? "";

  async function go() {
    if (!to) return;
    if (!window.confirm(`ย้าย ${sel.length} รายการไปสาขา ${toName} ใช่หรือไม่?\nวันที่ ยอด และเอกสารเดิมไม่เปลี่ยน ย้ายกลับได้ภายหลัง`)) return;
    setBusy(true); setRes(null);
    try {
      const r = await fetch(apiUrl("/api/accounta/move-branch"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, ids: sel, toBranchId: Number(to), reason: reason.trim() || null }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setRes({ ok: false, text: j.message ?? "ย้ายไม่สำเร็จ", blocked: [] }); setBusy(false); return; }
      const results = j.results as Result[];
      const blocked = results.filter((x) => x.status === "blocked" || x.status === "not_found");
      setRes({ ok: true, text: `ย้ายแล้ว ${j.moved} รายการไปสาขา ${toName}${blocked.length ? ` · ย้ายไม่ได้ ${blocked.length} รายการ` : ""}`, blocked });
      clear(); setReason(""); await onDone();
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
          <button type="button" className="btn-primary min-h-[44px] px-4" disabled={busy || !to} onClick={go}>{busy ? "กำลังย้าย…" : "ย้ายสาขา"}</button>
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
