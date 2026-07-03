"use client";

import { useState } from "react";
import { apiUrl } from "@/lib/url";
import { fmtMoney, grpMoney, parseMoney } from "@/lib/format";
import { humanizeApiError } from "@/lib/error-messages";
import { splitVat, round2, CAPEX_CATEGORY_CODE, DOC_TYPES, docTypeLabel } from "@/lib/accounta";
import { STARTUP_CATEGORIES, STARTUP_CATEGORY_LABEL } from "@/lib/feasibility";
import Select from "@/app/components/Select";

// Full editable shape of an expense row (the daybook passes these fields through).
export type EditableExpense = {
  id: number;
  bill_date: string;
  vendor_name: string | null;
  doc_type: string | null;
  category: string | null;
  capex_bucket: string | null;
  description: string | null;
  amount_total: number;
  has_tax_invoice: boolean;
  payment_status: "paid" | "unpaid";
  payment_method: string | null;
  paid_date: string | null;
  due_date: string | null;
  branch_id: number | null;
  company_id: number | null;
};

// In-place edit modal for a รายจ่าย row — so the daybook is a self-contained
// workspace and editing never leaves the page (owner 2026-06-29). Covers the
// fields that matter for an existing bill; OCR/doc-attach live on the รายจ่าย page.
export default function ExpenseEditModal({
  expense, categories, vendors, paymentMethods, mode = "edit", onClose, onSaved
}: {
  expense: EditableExpense;
  categories: Array<{ code: string | null; name: string }>;
  vendors: Array<{ name: string; tax_id: string | null }>;
  paymentMethods: Array<{ id: number; name: string }>;
  mode?: "edit" | "create";
  onClose: () => void;
  onSaved: (savedDate?: string) => void;
}) {
  const isCreate = mode === "create";
  const [vendor, setVendor] = useState(expense.vendor_name ?? "");
  const [category, setCategory] = useState(expense.category ?? "");
  const [capexBucket, setCapexBucket] = useState(
    expense.capex_bucket && (STARTUP_CATEGORIES as readonly string[]).includes(expense.capex_bucket) ? expense.capex_bucket : ""
  );
  const [description, setDescription] = useState(expense.description ?? "");
  // Only keep a doc_type the dropdown can represent (legacy/imported rows may
  // carry a non-standard value that z.enum would reject) — mirrors the รายจ่าย page.
  const [docType, setDocType] = useState(
    expense.doc_type && (DOC_TYPES as readonly string[]).includes(expense.doc_type) ? expense.doc_type : ""
  );
  const [billDate, setBillDate] = useState(expense.bill_date);
  const [amount, setAmount] = useState(isCreate ? "" : grpMoney(String(expense.amount_total)));
  const [hasVat, setHasVat] = useState(expense.has_tax_invoice);
  const [vatOverride, setVatOverride] = useState("");
  const [status, setStatus] = useState<"paid" | "unpaid">(expense.payment_status);
  const [method, setMethod] = useState(expense.payment_method ?? (paymentMethods[0]?.name ?? ""));
  const [paidDate, setPaidDate] = useState(expense.paid_date ?? expense.bill_date);
  const [dueDate, setDueDate] = useState(expense.due_date ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isCapex = categories.find((c) => c.name === category)?.code === CAPEX_CATEGORY_CODE;
  const total = parseMoney(amount) || 0;
  const vat = vatOverride.trim() !== ""
    ? round2(Number(vatOverride) || 0)
    : (hasVat ? splitVat(round2(total), true).vat : 0);

  async function save() {
    if (!Number.isFinite(total) || total <= 0) { setErr("กรอกยอดเงินให้ถูกต้อง"); return; }
    setBusy(true); setErr(null);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const body = {
        branch_id: expense.branch_id, company_id: expense.company_id,
        bill_date: billDate, vendor_name: vendor.trim() || null,
        doc_type: docType || null, category: category || null,
        capex_bucket: isCapex ? (capexBucket || null) : null,
        description: description.trim() || null, amount_total: round2(total),
        has_tax_invoice: hasVat, vat_amount: vat,
        payment_status: status,
        payment_method: status === "paid" ? (method || null) : null,
        paid_date: status === "paid" ? paidDate : null,
        due_date: status === "unpaid" ? (dueDate || null) : null,
        note: note.trim() || null
      };
      let res: Response;
      try { res = await fetch(
        apiUrl(isCreate ? "/api/accounta/expenses" : `/api/accounta/expenses/${expense.id}`), {
        method: isCreate ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
      } catch (e) {
        setErr((e as { name?: string })?.name === "AbortError" ? "ใช้เวลานานเกินไป — ลองอีกครั้ง" : "เชื่อมต่อไม่ได้ — ลองอีกครั้ง");
        return;
      }
      if (res.redirected && /\/login(\?|$)/.test(res.url)) { setErr("เซสชันหมดอายุ — เข้าสู่ระบบใหม่แล้วลองอีกครั้ง"); return; }
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "บันทึกไม่สำเร็จ")); return; }
      onSaved(billDate);
    } finally { clearTimeout(timer); setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/40 p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl my-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <div className="text-sm font-bold text-slate-800">{isCreate ? "เพิ่มรายจ่าย" : "แก้ไขรายจ่าย"}</div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none">✕</button>
        </div>
        <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3.5">
          <div>
            <label className="label !text-xs">วันที่เอกสาร</label>
            <input type="date" className="input" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
          </div>
          <div>
            <label className="label !text-xs">หมวดหมู่</label>
            <Select value={category} onChange={setCategory} placeholder="— เลือก —"
              options={categories.map((c) => ({ value: c.name, label: c.code ? `${c.code} · ${c.name}` : c.name }))} />
          </div>

          <div className="sm:col-span-2">
            <label className="label !text-xs">ประเภทเอกสาร</label>
            <Select value={docType} onChange={setDocType} placeholder="— ไม่ระบุ —"
              options={DOC_TYPES.map((dt) => ({ value: dt, label: docTypeLabel(dt) ?? dt }))} />
          </div>

          {isCapex && (
            <div className="sm:col-span-2">
              <label className="label !text-xs">หมวดลงทุน (สำหรับ FEASIBILITY)</label>
              <Select value={capexBucket} onChange={setCapexBucket} placeholder="— ไม่ระบุ (ไม่ดึงเข้าโปรเจค) —"
                options={STARTUP_CATEGORIES.map((b) => ({ value: b, label: STARTUP_CATEGORY_LABEL[b] }))} />
            </div>
          )}

          <div className="sm:col-span-2">
            <label className="label !text-xs">ผู้จำหน่าย / ผู้รับเงิน</label>
            <input className="input" list="exp-edit-vendors" value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="ชื่อผู้จำหน่าย" />
            <datalist id="exp-edit-vendors">{vendors.map((v) => <option key={v.name} value={v.name} />)}</datalist>
          </div>

          <div className="sm:col-span-2">
            <label className="label !text-xs">รายละเอียด</label>
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="เช่น ค่าวัสดุ" />
          </div>

          <div>
            <label className="label !text-xs">ยอดรวมที่จ่าย (รวม VAT)</label>
            <input type="text" inputMode="decimal" className="input text-right font-mono" value={amount} onChange={(e) => setAmount(grpMoney(e.target.value))} />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600 self-end pb-2">
            <input type="checkbox" checked={hasVat} onChange={(e) => setHasVat(e.target.checked)} />
            มีใบกำกับภาษีเต็มรูป (แยก VAT 7%)
          </label>
          {hasVat && (
            <div className="sm:col-span-2 text-[11px] text-slate-400 -mt-2 flex items-center gap-2 flex-wrap">
              <span>ฐานภาษี ฿{fmtMoney(round2(total - vat))} · ภาษีซื้อ <span className="text-brand font-semibold">฿{fmtMoney(vat)}</span></span>
              <input type="number" inputMode="decimal" className="input !inline-block !w-24 !py-1"
                value={vatOverride} onChange={(e) => setVatOverride(e.target.value)}
                placeholder="แก้ VAT" title="กรอกถ้าต้องการกำหนด VAT เอง (เว้นว่าง = คำนวณ 7%)" />
            </div>
          )}

          <div>
            <label className="label !text-xs">สถานะ</label>
            <Select value={status} onChange={(v) => setStatus(v as "paid" | "unpaid")}
              options={[{ value: "paid", label: "ชำระแล้ว" }, { value: "unpaid", label: "ค้างชำระ (เครดิตเทอม)" }]} />
          </div>
          {status === "paid" ? (
            <div>
              <label className="label !text-xs">จ่ายโดย</label>
              <Select value={method} onChange={setMethod} placeholder="— เลือก —"
                options={[
                  ...(method && !paymentMethods.some((m) => m.name === method) ? [{ value: method, label: method }] : []),
                  ...paymentMethods.map((m) => ({ value: m.name, label: m.name }))
                ]} />
            </div>
          ) : (
            <div>
              <label className="label !text-xs">วันครบกำหนดชำระ</label>
              <input type="date" className="input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
          )}
          {status === "paid" && (
            <div>
              <label className="label !text-xs">วันที่เงินออกจริง</label>
              <input type="date" className="input" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} />
            </div>
          )}

          <div className="sm:col-span-2">
            <label className="label !text-xs">หมายเหตุ (เพิ่มเติม)</label>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="เว้นว่างได้" />
          </div>

          {err && <div className="sm:col-span-2 text-xs text-rose-600">{err}</div>}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-100">
          <button type="button" onClick={onClose}
            className="rounded-md border border-slate-300 bg-white text-slate-600 px-5 py-2 text-sm font-medium hover:bg-slate-50">
            ยกเลิก
          </button>
          <button type="button" onClick={save} disabled={busy}
            className="rounded-md bg-brand text-white px-5 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50">
            {busy ? "กำลังบันทึก…" : isCreate ? "เพิ่ม" : "บันทึก"}
          </button>
        </div>
      </div>
    </div>
  );
}
