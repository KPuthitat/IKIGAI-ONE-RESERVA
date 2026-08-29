"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { fmtMoney, grpMoney, parseMoney } from "@/lib/format";
import { humanizeApiError } from "@/lib/error-messages";
import { splitVat, round2, CAPEX_CATEGORY_CODE } from "@/lib/accounta";
import { STARTUP_CATEGORIES, STARTUP_CATEGORY_LABEL } from "@/lib/feasibility";
import Select from "@/app/components/Select";
import { useConfirm } from "@/app/components/useConfirm";

type Row = {
  id: number; vendor_name: string | null; category: string | null; capex_bucket: string | null;
  doc_type: string | null; description: string | null; amount_total: number; has_tax_invoice: number;
  vat_amount: number; wht_rate: number; payment_status: "paid" | "unpaid"; payment_method: string | null; note: string | null;
  day_of_month: number; start_month: string; end_month: string | null; active: number; last_posted_month: string | null;
  is_fixed: number;
};
type Cat = { code: string | null; name: string };
type Method = { id: number; name: string };
type Vendor = { name: string; tax_id: string | null };

function thisMonth() { return new Date().toISOString().slice(0, 7); }
const TH_MON = ["", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
function monthLabel(ym: string | null): string {
  if (!ym) return "ไม่มีกำหนด";
  const [y, m] = ym.split("-").map(Number);
  return `${TH_MON[m]} ${y + 543}`;
}

type Form = {
  id: number | null; vendor_name: string; category: string; capex_bucket: string; description: string;
  amount: string; has_tax_invoice: boolean; wht_rate: string; payment_status: "paid" | "unpaid"; payment_method: string;
  day_of_month: string; start_month: string; end_month: string; note: string; active: boolean; is_fixed: boolean;
};
function blank(defaultMethod: string): Form {
  return {
    id: null, vendor_name: "", category: "", capex_bucket: "", description: "",
    amount: "", has_tax_invoice: false, wht_rate: "0", payment_status: "unpaid", payment_method: defaultMethod,
    day_of_month: "1", start_month: thisMonth(), end_month: "", note: "", active: true, is_fixed: true
  };
}

export default function RecurringClient({
  branchId, companyId, branchName, companyName, initial, categories, paymentMethods, vendors
}: {
  branchId: number; companyId: number | null; branchName: string; companyName: string;
  initial: Row[]; categories: Cat[]; paymentMethods: Method[]; vendors: Vendor[];
}) {
  const router = useRouter();
  const { confirm, ConfirmDialog } = useConfirm();
  const [rows, setRows] = useState<Row[]>(initial);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(blank(paymentMethods[0]?.name ?? ""));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const isCapex = categories.find((c) => c.name === form.category)?.code === CAPEX_CATEGORY_CODE;
  const total = parseMoney(form.amount) || 0;
  const vat = form.has_tax_invoice ? splitVat(round2(total), true).vat : 0;
  // WHT computed on the ex-VAT base × rate (same rule as the daybook form).
  const whtRateNum = Number(form.wht_rate) || 0;
  const whtAmount = round2(round2(total - vat) * whtRateNum);

  async function reload() {
    const r = await fetch(apiUrl(`/api/accounta/recurring?branch=${branchId}`));
    const j = await r.json().catch(() => ({}));
    if (j.ok) setRows(j.recurring);
  }

  function openNew() { setForm(blank(paymentMethods[0]?.name ?? "")); setErr(null); setOpen(true); }
  function openEdit(r: Row) {
    setForm({
      id: r.id, vendor_name: r.vendor_name ?? "", category: r.category ?? "",
      capex_bucket: r.capex_bucket && STARTUP_CATEGORIES.includes(r.capex_bucket as never) ? r.capex_bucket : "",
      description: r.description ?? "", amount: grpMoney(String(r.amount_total)),
      has_tax_invoice: !!r.has_tax_invoice, wht_rate: String(r.wht_rate ?? 0), payment_status: r.payment_status,
      payment_method: r.payment_method ?? (paymentMethods[0]?.name ?? ""),
      day_of_month: String(r.day_of_month), start_month: r.start_month, end_month: r.end_month ?? "",
      note: r.note ?? "", active: !!r.active, is_fixed: r.is_fixed !== 0
    });
    setErr(null); setOpen(true);
  }

  async function save() {
    if (!(total > 0)) { setErr("กรอกยอดเงินให้ถูกต้อง"); return; }
    if (!/^\d{4}-\d{2}$/.test(form.start_month)) { setErr("เลือกเดือนเริ่มต้น"); return; }
    if (form.end_month && form.end_month < form.start_month) { setErr("เดือนสิ้นสุดต้องไม่ก่อนเดือนเริ่ม"); return; }
    setBusy(true); setErr(null);
    try {
      const body = {
        branch_id: branchId, company_id: companyId,
        vendor_name: form.vendor_name.trim() || null, category: form.category || null,
        capex_bucket: isCapex ? (form.capex_bucket || null) : null,
        doc_type: null, description: form.description.trim() || null,
        amount_total: round2(total), has_tax_invoice: form.has_tax_invoice, vat_amount: vat,
        wht_rate: Number(form.wht_rate) || 0,
        payment_status: form.payment_status, payment_method: form.payment_status === "paid" ? (form.payment_method || null) : null,
        note: form.note.trim() || null,
        day_of_month: Math.min(31, Math.max(1, Number(form.day_of_month) || 1)),
        start_month: form.start_month, end_month: form.end_month || null, active: form.active, is_fixed: form.is_fixed
      };
      const res = await fetch(apiUrl(form.id ? `/api/accounta/recurring/${form.id}` : "/api/accounta/recurring"), {
        method: form.id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "บันทึกไม่สำเร็จ")); return; }
      setOpen(false); await reload(); router.refresh();
    } finally { setBusy(false); }
  }

  async function toggle(r: Row) {
    await fetch(apiUrl(`/api/accounta/recurring/${r.id}`), {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: !r.active })
    });
    await reload();
  }
  async function remove(r: Row) {
    const ok = await confirm({ title: "ลบรายจ่ายประจำ", body: `ลบ "${r.vendor_name ?? r.description ?? "รายการนี้"}" ? (รายการที่ลงไปแล้วไม่ถูกลบ)`, confirmLabel: "ลบ", cancelLabel: "ยกเลิก", variant: "danger" });
    if (ok === null) return;
    await fetch(apiUrl(`/api/accounta/recurring/${r.id}`), { method: "DELETE" });
    await reload();
  }

  return (
    <div className="space-y-3">
      {ConfirmDialog}
      <div className="flex justify-end">
        <button type="button" onClick={openNew} className="rounded-full bg-rose-600 text-white px-3 py-1.5 text-sm font-medium hover:bg-rose-700">+ เพิ่มรายจ่ายประจำ</button>
      </div>

      <div className="card overflow-x-auto">
        {rows.length === 0 ? (
          <p className="text-sm text-slate-400">ยังไม่มีรายจ่ายประจำ — กด “เพิ่มรายจ่ายประจำ” เพื่อตั้งรายการที่ลงทุกเดือนอัตโนมัติ</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] text-slate-400 border-b border-slate-200 text-left">
                <th className="py-1.5 px-2">ผู้จำหน่าย / รายการ</th>
                <th className="py-1.5 px-2">หมวด</th>
                <th className="py-1.5 px-2 text-right">ยอด/เดือน</th>
                <th className="py-1.5 px-2 text-center">ลงทุกวันที่</th>
                <th className="py-1.5 px-2">ช่วง</th>
                <th className="py-1.5 px-2 text-center">สถานะ</th>
                <th className="py-1.5 px-2 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={`border-b border-slate-50 ${r.active ? "" : "opacity-50"}`}>
                  <td className="py-1.5 px-2">
                    <div className="text-slate-700">{r.vendor_name || r.description || "—"}</div>
                    {r.payment_status === "paid" && r.payment_method && <div className="text-[11px] text-slate-400">จ่ายโดย {r.payment_method}</div>}
                  </td>
                  <td className="py-1.5 px-2 text-slate-500 text-xs">{r.category || "—"}</td>
                  <td className="py-1.5 px-2 text-right font-mono text-rose-700">฿{fmtMoney(r.amount_total)}</td>
                  <td className="py-1.5 px-2 text-center text-slate-600">{r.day_of_month}</td>
                  <td className="py-1.5 px-2 text-xs text-slate-500 whitespace-nowrap">{monthLabel(r.start_month)} – {monthLabel(r.end_month)}</td>
                  <td className="py-1.5 px-2 text-center">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${r.active ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-500"}`}>
                      {r.active ? "ทำงาน" : "หยุด"}
                    </span>
                  </td>
                  <td className="py-1.5 px-2 text-right whitespace-nowrap">
                    <button type="button" onClick={() => openEdit(r)} className="text-xs text-slate-500 hover:text-brand">แก้ไข</button>
                    <button type="button" onClick={() => toggle(r)} className="text-xs text-slate-500 hover:text-brand ml-3">{r.active ? "หยุด" : "เปิด"}</button>
                    <button type="button" onClick={() => remove(r)} className="text-xs text-slate-400 hover:text-rose-600 ml-3">ลบ</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/40 p-4 overflow-y-auto" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl my-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
              <div className="text-sm font-bold text-slate-800">{form.id ? "แก้ไขรายจ่ายประจำ" : "เพิ่มรายจ่ายประจำ"}</div>
              <button type="button" onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600 text-lg leading-none">✕</button>
            </div>
            <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3.5">
              <div className="sm:col-span-2 text-[11px] text-slate-400">สาขา {branchName}{companyName ? ` · ${companyName}` : ""}</div>

              <div>
                <label className="label !text-xs">ลงทุกวันที่ของเดือน</label>
                <input type="number" min={1} max={31} className="input" value={form.day_of_month} onChange={(e) => set("day_of_month", e.target.value)} />
              </div>
              <div>
                <label className="label !text-xs">หมวดหมู่</label>
                <Select value={form.category} onChange={(v) => set("category", v)} placeholder="— เลือก —"
                  options={categories.map((c) => ({ value: c.name, label: c.code ? `${c.code} · ${c.name}` : c.name }))} />
              </div>

              {isCapex && (
                <div className="sm:col-span-2">
                  <label className="label !text-xs">หมวดลงทุน (สำหรับ FEASIBILITY)</label>
                  <Select value={form.capex_bucket} onChange={(v) => set("capex_bucket", v)} placeholder="— ไม่ระบุ —"
                    options={STARTUP_CATEGORIES.map((b) => ({ value: b, label: STARTUP_CATEGORY_LABEL[b] }))} />
                </div>
              )}

              <div className="sm:col-span-2">
                <label className="label !text-xs">ผู้จำหน่าย / ผู้รับเงิน</label>
                <input className="input" list="rec-vendors" value={form.vendor_name} onChange={(e) => set("vendor_name", e.target.value)} placeholder="เช่น บริษัทให้เช่าอาคาร" />
                <datalist id="rec-vendors">{vendors.map((v) => <option key={v.name} value={v.name} />)}</datalist>
              </div>
              <div className="sm:col-span-2">
                <label className="label !text-xs">รายละเอียด</label>
                <input className="input" value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="เช่น ค่าเช่าร้าน" />
              </div>

              <div>
                <label className="label !text-xs">ยอดต่อเดือน (รวม VAT)</label>
                <input type="text" inputMode="decimal" className="input text-right font-mono" value={form.amount} onChange={(e) => set("amount", grpMoney(e.target.value))} />
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-600 self-end pb-2">
                <input type="checkbox" checked={form.has_tax_invoice} onChange={(e) => set("has_tax_invoice", e.target.checked)} />
                มีใบกำกับภาษีเต็มรูป (แยก VAT 7%)
              </label>
              {form.has_tax_invoice && <div className="sm:col-span-2 text-[11px] text-slate-400 -mt-2">ฐานภาษี ฿{fmtMoney(round2(total - vat))} · ภาษีซื้อ ฿{fmtMoney(vat)}</div>}

              <div>
                <label className="label !text-xs">หัก ณ ที่จ่าย</label>
                <Select value={form.wht_rate} onChange={(v) => set("wht_rate", v)}
                  options={[
                    { value: "0", label: "ไม่หัก" },
                    { value: "0.01", label: "1% (ค่าขนส่ง)" },
                    { value: "0.03", label: "3% (ค่าบริการ/รับจ้าง)" },
                    { value: "0.05", label: "5% (ค่าเช่า)" }
                  ]} />
              </div>
              {whtRateNum > 0 && (
                <div className="text-[11px] text-slate-500 self-end pb-2">
                  หัก ณ ที่จ่าย <span className="text-rose-600 font-semibold">฿{fmtMoney(whtAmount)}</span> ต่อเดือน ·
                  จ่ายจริง <span className="text-slate-800 font-semibold">฿{fmtMoney(round2(total - whtAmount))}</span>
                </div>
              )}

              <div>
                <label className="label !text-xs">สถานะ (ของรายการที่สร้าง)</label>
                <Select value={form.payment_status} onChange={(v) => set("payment_status", v as "paid" | "unpaid")}
                  options={[{ value: "unpaid", label: "ค้างชำระ (ไปกดจ่ายทีหลัง)" }, { value: "paid", label: "ชำระแล้ว (ตัดจ่ายทันที)" }]} />
              </div>
              {form.payment_status === "paid" && (
                <div>
                  <label className="label !text-xs">จ่ายโดย</label>
                  <Select value={form.payment_method} onChange={(v) => set("payment_method", v)} placeholder="— เลือก —"
                    options={[
                      ...(form.payment_method && !paymentMethods.some((m) => m.name === form.payment_method) ? [{ value: form.payment_method, label: form.payment_method }] : []),
                      ...paymentMethods.map((m) => ({ value: m.name, label: m.name }))
                    ]} />
                </div>
              )}

              <div>
                <label className="label !text-xs">เดือนเริ่ม</label>
                <input type="month" className="input" value={form.start_month} onChange={(e) => set("start_month", e.target.value)} />
              </div>
              <div>
                <label className="label !text-xs">เดือนสิ้นสุด (เว้นว่าง = ต่อเนื่อง)</label>
                <input type="month" className="input" value={form.end_month} onChange={(e) => set("end_month", e.target.value)} />
              </div>

              <div className="sm:col-span-2">
                <label className="label !text-xs">หมายเหตุ</label>
                <input className="input" value={form.note} onChange={(e) => set("note", e.target.value)} placeholder="เว้นว่างได้" />
              </div>
              <label className="sm:col-span-2 flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} />
                เปิดทำงาน (ลงรายการอัตโนมัติ)
              </label>
              {/* Fixed-cost flag for break-even (owner 2026-07-21) — recurring
                  expenses default fixed. Each auto-posted row inherits this. */}
              <label className="sm:col-span-2 flex items-center gap-2 text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                <input type="checkbox" checked={form.is_fixed} onChange={(e) => set("is_fixed", e.target.checked)} />
                เป็น<strong>รายจ่ายคงที่</strong> (จุดคุ้มทุน) — รายจ่ายประจำมักเป็นคงที่ · เอาออกถ้าเป็นแปรผัน
              </label>

              {err && <div className="sm:col-span-2 text-xs text-rose-600">{err}</div>}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-100">
              <button type="button" onClick={() => setOpen(false)} className="rounded-md border border-slate-300 bg-white text-slate-600 px-5 py-2 text-sm font-medium hover:bg-slate-50">ยกเลิก</button>
              <button type="button" onClick={save} disabled={busy} className="rounded-md bg-brand text-white px-5 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50">
                {busy ? "กำลังบันทึก…" : "บันทึก"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
