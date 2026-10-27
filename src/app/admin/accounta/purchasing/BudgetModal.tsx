"use client";

import { useMemo, useState } from "react";
import { apiUrl } from "@/lib/url";
import PinPromptModal from "@/app/components/PinPromptModal";
import { api, KIND_LABEL, type Overview } from "./types";

// Approvers set the year's budget for one branch at a time: one amount per ACCOUNTA category (0 / empty = no budget).
export default function BudgetModal({ data, onClose, onSaved }: { data: Overview; onClose: () => void; onSaved: () => void }) {
  const [branchId, setBranchId] = useState<number>(data.branches[0]?.id ?? 0);
  const initial = useMemo(() => {
    const m: Record<string, string> = {};
    for (const u of data.usage) if (u.branchId === branchId && u.budget > 0) m[u.category] = String(u.budget);
    return m;
  }, [data.usage, branchId]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [pin, setPin] = useState(false);
  const val = (c: string) => edits[c] ?? initial[c] ?? "";
  const num = (c: string) => { const n = Number(val(c).replace(/,/g, "")); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0; };
  const total = (k: "opex" | "capex") => data.categories.filter((c) => c.kind === k).reduce((s, c) => s + num(c.name), 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 pt-5 pb-3 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
          <div><div className="text-lg font-bold text-slate-800">ตั้งงบประมาณ ปี {data.year + 543}</div><div className="text-xs text-slate-500">ใส่เฉพาะหมวดที่ต้องการคุมงบ · เว้นว่าง = ไม่ตั้งงบ</div></div>
          <select className="input !w-auto" value={branchId} onChange={(e) => { setBranchId(Number(e.target.value)); setEdits({}); }}>
            {data.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div className="px-6 py-4 space-y-1">
          {data.categories.map((c) => (
            <div key={c.name} className="flex items-center gap-2">
              <span className={`tag ${c.kind === "capex" ? "tag-info" : "tag-mute"} w-14 text-center`}>{KIND_LABEL[c.kind]}</span>
              <span className="flex-1 text-sm text-slate-700">{c.name}</span>
              <input className="input !w-36 text-right tabular-nums" inputMode="decimal" placeholder="0" value={val(c.name)} onChange={(e) => setEdits((x) => ({ ...x, [c.name]: e.target.value }))} />
            </div>
          ))}
        </div>
        <div className="px-6 pb-5 flex items-center gap-3 flex-wrap">
          <div className="text-xs text-slate-500 flex-1">OPEX รวม ฿{total("opex").toLocaleString()} · CAPEX รวม ฿{total("capex").toLocaleString()}</div>
          <button type="button" className="btn-secondary text-sm" onClick={onClose}>ปิด</button>
          <button type="button" className="btn-primary text-sm" onClick={() => setPin(true)}>บันทึกงบ (ใส่ PIN)</button>
        </div>
      </div>
      {pin && (
        <PinPromptModal title="ยืนยันการตั้งงบประมาณ" description={<p className="text-xs text-slate-600">บันทึกงบปี {data.year + 543} ของสาขาที่เลือก</p>} submitLabel="บันทึก" onClose={() => setPin(false)}
          onSubmit={async (p) => {
            const budget = data.categories.map((c) => ({ branch_id: branchId, category: c.name, amount: num(c.name) }));
            const r = await api(apiUrl("/api/admin/accounta/purchasing"), { method: "POST", body: { action: "set_budget", year: data.year, budget, pin: p } });
            if (!r.ok) return { ok: false as const, message: r.j.message ?? "บันทึกไม่สำเร็จ" };
            onSaved(); return { ok: true as const };
          }} />
      )}
    </div>
  );
}
