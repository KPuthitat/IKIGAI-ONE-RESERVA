"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/url";

type Mode = "one_req" | "one_opt" | "multi";
type Choice = { name: string; delta: string; available: boolean };
type Group = { name: string; mode: Mode; maxPick: string; choices: Choice[] };
type ApiGroup = { name: string; minPick: number; maxPick: number; choices: Array<{ name: string; priceDelta: number; available: boolean }> };

const MODE_LABEL: Record<Mode, string> = { one_req: "เลือก 1 อย่าง (ต้องเลือก)", one_opt: "เลือก 1 อย่าง (ไม่บังคับ)", multi: "เลือกได้หลายอย่าง (ไม่บังคับ)" };

// Ready-made sets for a drink menu (owner 2026-10-30: เหมือนแอปสั่งชา) — a starting point the owner then edits.
const DRINK_TEMPLATE: Group[] = [
  { name: "ขนาด", mode: "one_req", maxPick: "1", choices: [{ name: "ธรรมดา", delta: "0", available: true }, { name: "ใหญ่", delta: "10", available: true }] },
  { name: "ความหวาน", mode: "one_req", maxPick: "1", choices: ["100%", "75%", "50%", "25%", "ไม่หวาน"].map((n) => ({ name: n, delta: "0", available: true })) },
  { name: "น้ำแข็ง", mode: "one_req", maxPick: "1", choices: ["ปกติ", "น้อย", "ไม่ใส่น้ำแข็ง"].map((n) => ({ name: n, delta: "0", available: true })) },
  { name: "ท็อปปิ้ง", mode: "multi", maxPick: "3", choices: [{ name: "ไข่มุก", delta: "10", available: true }, { name: "บุก", delta: "10", available: true }, { name: "ครีมชีส", delta: "15", available: true }] }
];

function fromApi(g: ApiGroup): Group {
  const mode: Mode = g.maxPick === 1 ? (g.minPick >= 1 ? "one_req" : "one_opt") : "multi";
  return { name: g.name, mode, maxPick: String(g.maxPick), choices: g.choices.map((c) => ({ name: c.name, delta: String(c.priceDelta), available: c.available })) };
}

export default function OptionsEditor({ itemId, itemName, onClose, onSaved }: { itemId: number; itemName: string; onClose: () => void; onSaved: (groupCount: number) => void }) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await fetch(apiUrl(`/api/admin/delivera/menu/${itemId}/options`), { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      setGroups(r.ok && j.ok ? (j.groups as ApiGroup[]).map(fromApi) : []);
    })();
  }, [itemId]);

  const setG = (i: number, patch: Partial<Group>) => setGroups((gs) => (gs ?? []).map((g, k) => (k === i ? { ...g, ...patch } : g)));
  const setC = (gi: number, ci: number, patch: Partial<Choice>) => setGroups((gs) => (gs ?? []).map((g, k) => (k === gi ? { ...g, choices: g.choices.map((c, m) => (m === ci ? { ...c, ...patch } : c)) } : g)));

  async function save() {
    if (!groups) return;
    setBusy(true); setErr(null);
    try {
      const body = {
        groups: groups.map((g) => {
          const n = g.choices.length;
          const max = g.mode === "multi" ? Math.max(1, Math.min(n, Number(g.maxPick) || n)) : 1;
          return { name: g.name.trim(), min_pick: g.mode === "one_req" ? 1 : 0, max_pick: max,
            choices: g.choices.filter((c) => c.name.trim()).map((c) => ({ name: c.name.trim(), price_delta: Number(c.delta) || 0, is_available: c.available })) };
        })
      };
      const r = await fetch(apiUrl(`/api/admin/delivera/menu/${itemId}/options`), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setErr(j.message ?? "บันทึกไม่สำเร็จ"); return; }
      onSaved(body.groups.length); onClose();
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/50 p-3 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full my-4" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-4 pb-3 border-b border-slate-100 flex items-start justify-between gap-3">
          <div><div className="text-lg font-bold text-slate-800">ตัวเลือกของเมนู</div><div className="text-sm text-slate-500">{itemName}</div></div>
          <button type="button" className="text-slate-400 hover:text-slate-600 text-xl leading-none" onClick={onClose} aria-label="ปิด">×</button>
        </div>
        {groups === null ? <div className="p-5 text-sm text-slate-400">กำลังโหลด…</div> : (
          <div className="px-5 py-4 space-y-4">
            {groups.length === 0 && <p className="text-sm text-slate-500">ยังไม่มีตัวเลือก — ลูกค้าจะสั่งเมนูนี้ได้ทันทีโดยไม่ต้องเลือกอะไร เพิ่มกลุ่มตัวเลือกด้านล่าง หรือใช้ชุดสำเร็จรูปสำหรับเครื่องดื่ม</p>}
            {groups.map((g, gi) => (
              <div key={gi} className="rounded-xl border border-slate-200 p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <input className="input flex-1 min-w-[8rem]" placeholder="ชื่อกลุ่ม เช่น ขนาด" value={g.name} onChange={(e) => setG(gi, { name: e.target.value })} />
                  <select className="input !w-auto" value={g.mode} onChange={(e) => setG(gi, { mode: e.target.value as Mode })}>
                    {(Object.keys(MODE_LABEL) as Mode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
                  </select>
                  {g.mode === "multi" && <label className="text-xs text-slate-500 flex items-center gap-1">สูงสุด <input className="input !w-14 !py-1 text-center" inputMode="numeric" value={g.maxPick} onChange={(e) => setG(gi, { maxPick: e.target.value })} /> อย่าง</label>}
                  <button type="button" className="text-xs text-rose-500 hover:underline" onClick={() => setGroups((gs) => (gs ?? []).filter((_, k) => k !== gi))}>ลบกลุ่ม</button>
                </div>
                <div className="space-y-1.5">
                  {g.choices.map((c, ci) => (
                    <div key={ci} className="flex items-center gap-2">
                      <input className="input flex-1" placeholder="ชื่อตัวเลือก" value={c.name} onChange={(e) => setC(gi, ci, { name: e.target.value })} />
                      <label className="text-xs text-slate-500 flex items-center gap-1">+฿<input className="input !w-20 !py-1 text-right" inputMode="decimal" value={c.delta} onChange={(e) => setC(gi, ci, { delta: e.target.value })} /></label>
                      <label className="text-xs text-slate-500 flex items-center gap-1"><input type="checkbox" checked={c.available} onChange={(e) => setC(gi, ci, { available: e.target.checked })} />มี</label>
                      <button type="button" className="text-rose-400 hover:text-rose-600" aria-label="ลบตัวเลือก" onClick={() => setG(gi, { choices: g.choices.filter((_, k) => k !== ci) })}>×</button>
                    </div>
                  ))}
                  <button type="button" className="text-sm text-brand hover:underline" onClick={() => setG(gi, { choices: [...g.choices, { name: "", delta: "0", available: true }] })}>+ เพิ่มตัวเลือก</button>
                </div>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-secondary text-sm" onClick={() => setGroups((gs) => [...(gs ?? []), { name: "", mode: "one_req", maxPick: "1", choices: [{ name: "", delta: "0", available: true }] }])}>+ เพิ่มกลุ่มตัวเลือก</button>
              <button type="button" className="btn-secondary text-sm" onClick={() => { if (groups.length === 0 || window.confirm("แทนที่ตัวเลือกที่แก้อยู่ด้วยชุดเครื่องดื่มสำเร็จรูปหรือไม่")) setGroups(DRINK_TEMPLATE.map((g) => ({ ...g, choices: g.choices.map((c) => ({ ...c })) }))); }}>ใช้ชุดเครื่องดื่ม (ขนาด/หวาน/น้ำแข็ง/ท็อปปิ้ง)</button>
            </div>
            {err && <div className="text-sm text-rose-600">{err}</div>}
            <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
              <button type="button" className="btn-secondary text-sm" onClick={onClose}>ปิด</button>
              <button type="button" className="btn-primary text-sm" disabled={busy} onClick={save}>{busy ? "…" : "บันทึกตัวเลือก"}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
