"use client";

import { useEffect, useState } from "react";
import { fmtMoney } from "@/lib/format";
import { apiUrl } from "@/lib/url";
import { api, KIND_LABEL, type Detail, type Overview } from "./types";

type Row = { description: string; qty: string; unit: string; price: string };
const blank = (): Row => ({ description: "", qty: "1", unit: "", price: "" });
const n = (s: string) => { const x = Number(s.replace(/,/g, "")); return Number.isFinite(x) ? x : 0; };

// New / edited purchase request (draft). Shows the budget effect live and asks for a reason when it would exceed the budget.
export default function PrFormModal({ data, editId, defaultBranch, onClose, onSaved }: {
  data: Overview; editId: number | null; defaultBranch: number | undefined; onClose: () => void; onSaved: (id: number) => void;
}) {
  const allowed = data.me.isApprover ? data.branches : data.branches.filter((b) => data.me.adminBranchIds.includes(b.id));
  const [branchId, setBranchId] = useState<number>(defaultBranch && allowed.some((b) => b.id === defaultBranch) ? defaultBranch : (allowed[0]?.id ?? 0));
  const [category, setCategory] = useState(data.categories[0]?.name ?? "");
  const [title, setTitle] = useState(""); const [reason, setReason] = useState(""); const [needed, setNeeded] = useState("");
  const [vendorId, setVendorId] = useState<string>(""); const [vendorName, setVendorName] = useState("");
  const [vat, setVat] = useState<0 | 7>(0); const [over, setOver] = useState("");
  const [rows, setRows] = useState<Row[]>([blank()]);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(editId == null);

  useEffect(() => {
    if (editId == null) return;
    void (async () => {
      const r = await api<Detail>(apiUrl(`/api/admin/accounta/purchasing?id=${editId}`));
      if (!r.ok) { setErr(r.j.message ?? "โหลดไม่สำเร็จ"); return; }
      const { pr, items } = r.j;
      setBranchId(pr.branchId); setCategory(pr.category); setTitle(pr.title); setReason(pr.reason); setNeeded(pr.neededDate ?? "");
      setVendorId(pr.vendorId ? String(pr.vendorId) : ""); setVendorName(pr.vendorName); setVat(pr.vatRate === 7 ? 7 : 0); setOver(pr.overBudgetReason);
      setRows(items.map((i) => ({ description: i.description, qty: String(i.qty), unit: i.unit, price: String(i.unitPrice) })));
      setLoaded(true);
    })();
  }, [editId]);

  const subtotal = Math.round(rows.reduce((s, r) => s + n(r.qty) * n(r.price), 0) * 100) / 100;
  const vatAmount = Math.round(subtotal * vat) / 100;
  const total = Math.round((subtotal + vatAmount) * 100) / 100;
  const usage = data.usage.find((u) => u.branchId === branchId && u.category === category);
  const remaining = usage?.remaining ?? 0;
  const after = Math.round((remaining - total) * 100) / 100;
  const isOver = total > 0 && after < 0;
  const kind = data.categories.find((c) => c.name === category)?.kind ?? "opex";
  const vendors = data.vendors[branchId] ?? [];
  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  async function save(submit: boolean) {
    setBusy(true); setErr(null);
    try {
      const pr = {
        ...(editId ? { id: editId } : {}), branch_id: branchId, category, title, reason, needed_date: needed || null,
        vendor_id: vendorId ? Number(vendorId) : null, vendor_name: vendorId ? undefined : vendorName, vat_rate: vat, over_budget_reason: over,
        items: rows.filter((r) => r.description.trim()).map((r) => ({ description: r.description, qty: n(r.qty), unit: r.unit, unit_price: n(r.price) }))
      };
      const s = await api<{ id: number }>(apiUrl("/api/admin/accounta/purchasing"), { method: "POST", body: { action: "save_pr", pr } });
      if (!s.ok) { setErr(s.j.message ?? "บันทึกไม่สำเร็จ"); return; }
      if (submit) {
        const r = await api(apiUrl("/api/admin/accounta/purchasing"), { method: "POST", body: { action: "submit", id: s.j.id } });
        if (!r.ok) { setErr(r.j.message ?? "ส่งอนุมัติไม่สำเร็จ"); onSaved(s.j.id); return; }
      }
      onSaved(s.j.id);
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/50 p-3 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full my-4" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 pt-5 pb-3 border-b border-slate-100 flex items-center justify-between">
          <div className="text-lg font-bold text-slate-800">{editId ? "แก้ไขใบขอซื้อ (PR)" : "สร้างใบขอซื้อ (PR)"}</div>
          <button type="button" className="text-slate-400 hover:text-slate-600 text-xl leading-none" onClick={onClose} aria-label="ปิด">×</button>
        </div>
        {!loaded ? <div className="p-6 text-sm text-slate-400">กำลังโหลด…</div> : (
          <div className="px-6 py-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="field"><span>สาขา</span><select className="input" value={branchId} disabled={!!editId} onChange={(e) => { setBranchId(Number(e.target.value)); setVendorId(""); }}>{allowed.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
              <label className="field"><span>หมวดค่าใช้จ่าย <span className={`tag ${kind === "capex" ? "tag-info" : "tag-mute"} ml-1`}>{KIND_LABEL[kind]}</span></span>
                <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>{data.categories.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select></label>
              <label className="field sm:col-span-2"><span>เรื่องที่ขอซื้อ</span><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="เช่น เครื่องวัดความดันเพิ่ม 2 เครื่อง" /></label>
              <label className="field sm:col-span-2"><span>เหตุผล / ความจำเป็น</span><textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
              <label className="field"><span>ต้องการใช้ภายในวันที่</span><input type="date" className="input" value={needed} onChange={(e) => setNeeded(e.target.value)} /></label>
              <label className="field"><span>ผู้ขาย</span>
                <select className="input" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                  <option value="">พิมพ์ชื่อผู้ขายเอง</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
                {!vendorId && <input className="input mt-1" value={vendorName} onChange={(e) => setVendorName(e.target.value)} placeholder="ชื่อผู้ขาย (ถ้ายังไม่ทราบ ใส่ตอนออก PO ได้)" />}
              </label>
            </div>

            <div>
              <div className="label">รายการ</div>
              <div className="space-y-2">
                {rows.map((r, i) => (
                  <div key={i} className="grid grid-cols-12 gap-2 items-center">
                    <input className="input col-span-12 sm:col-span-5" placeholder="รายการ" value={r.description} onChange={(e) => set(i, { description: e.target.value })} />
                    <input className="input col-span-3 sm:col-span-2 text-right" inputMode="decimal" placeholder="จำนวน" value={r.qty} onChange={(e) => set(i, { qty: e.target.value })} />
                    <input className="input col-span-3 sm:col-span-1" placeholder="หน่วย" value={r.unit} onChange={(e) => set(i, { unit: e.target.value })} />
                    <input className="input col-span-4 sm:col-span-2 text-right" inputMode="decimal" placeholder="ราคา/หน่วย" value={r.price} onChange={(e) => set(i, { price: e.target.value })} />
                    <div className="col-span-2 sm:col-span-1 text-right text-sm tabular-nums text-slate-600">{fmtMoney(n(r.qty) * n(r.price))}</div>
                    <button type="button" className="col-span-12 sm:col-span-1 text-rose-400 hover:text-rose-600 text-lg" onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((_, k) => k !== i) : rs))} aria-label="ลบรายการ">×</button>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between mt-2 flex-wrap gap-2">
                <button type="button" className="text-sm text-brand hover:underline" onClick={() => setRows((rs) => [...rs, blank()])}>+ เพิ่มรายการ</button>
                <div className="text-sm text-right space-y-0.5">
                  <div className="text-slate-500">ก่อน VAT ฿{fmtMoney(subtotal)}</div>
                  <label className="inline-flex items-center gap-1 text-slate-500">VAT <select className="input !w-auto !py-0.5" value={vat} onChange={(e) => setVat(Number(e.target.value) === 7 ? 7 : 0)}><option value={0}>ไม่มี</option><option value={7}>7%</option></select> ฿{fmtMoney(vatAmount)}</label>
                  <div className="font-bold text-slate-800">รวม ฿{fmtMoney(total)}</div>
                </div>
              </div>
            </div>

            <div className={`rounded-xl border px-4 py-3 text-sm ${isOver ? "border-rose-300 bg-rose-50" : "border-slate-200 bg-slate-50"}`}>
              <div className="font-semibold text-slate-700">ผลต่องบ {KIND_LABEL[kind]} · {category} (ปี {data.year + 543})</div>
              <div className="mt-1 text-slate-600">งบ ฿{fmtMoney(usage?.budget ?? 0)} · ใช้จริง ฿{fmtMoney(usage?.actual ?? 0)} · ผูกพัน ฿{fmtMoney(usage?.committed ?? 0)} → คงเหลือ <b>฿{fmtMoney(remaining)}</b></div>
              <div className={`mt-1 font-semibold ${isOver ? "text-rose-700" : "text-emerald-700"}`}>
                {total > 0 ? (isOver ? `เกินงบ ฿${fmtMoney(-after)} — ต้องใส่เหตุผลขอเกินงบก่อนส่งอนุมัติ` : `หลังขอซื้อนี้ คงเหลือ ฿${fmtMoney(after)}`) : "ใส่รายการและราคาเพื่อดูผลต่องบ"}
                {!usage?.budget && total > 0 && " (หมวดนี้ยังไม่ได้ตั้งงบ)"}
              </div>
              {isOver && <label className="field mt-2"><span>เหตุผลขอเกินงบ</span><textarea className="input" rows={2} value={over} onChange={(e) => setOver(e.target.value)} /></label>}
            </div>

            {err && <div className="text-sm text-rose-600">{err}</div>}
            <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
              <button type="button" className="btn-secondary text-sm" onClick={onClose}>ปิด</button>
              <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => save(false)}>บันทึกร่าง</button>
              <button type="button" className="btn-primary text-sm" disabled={busy} onClick={() => save(true)}>{busy ? "…" : "บันทึกและส่งอนุมัติ"}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
