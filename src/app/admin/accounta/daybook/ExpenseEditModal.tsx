"use client";

import { useState, useRef } from "react";
import { apiUrl } from "@/lib/url";
import { fmtMoney, grpMoney, parseMoney } from "@/lib/format";
import { humanizeApiError } from "@/lib/error-messages";
import { splitVat, round2, CAPEX_CATEGORY_CODE, DOC_TYPES, docTypeLabel } from "@/lib/accounta";
import { STARTUP_CATEGORIES, STARTUP_CATEGORY_LABEL } from "@/lib/feasibility";
import Select from "@/app/components/Select";

// Snapshot of a vendor's most-recent bill — prefilled into the form when the
// vendor is picked (owner 2026-07-24: "ส่วนใหญ่เป็นเจ้าเดิม ต่างแค่ยอด").
export type VendorLastBill = {
  category: string | null; description: string | null; doc_type: string | null;
  payment_method: string | null; payment_status: string;
  has_tax_invoice: number; wht_rate: number; is_fixed: number;
  due_mode: string | null; capex_bucket: string | null;
};

// Full editable shape of an expense row (the daybook passes these fields through).
export type EditableExpense = {
  id: number;
  bill_date: string;
  vendor_name: string | null;
  invoice_no: string | null;
  doc_type: string | null;
  category: string | null;
  capex_bucket: string | null;
  description: string | null;
  amount_total: number;
  has_tax_invoice: boolean;
  wht_rate?: number;
  awaiting_doc?: boolean;
  is_fixed?: boolean;
  payment_status: "paid" | "unpaid";
  payment_method: string | null;
  paid_date: string | null;
  due_date: string | null;
  due_mode?: string | null;
  branch_id: number | null;
  company_id: number | null;
};

// Next Monday strictly after `iso` (owner 2026-07-21: ชำระวันจันทร์ถัดไป).
function nextMonday(iso: string): string {
  const base = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : new Date().toISOString().slice(0, 10);
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (((1 - d.getUTCDay() + 6) % 7) + 1));
  return d.toISOString().slice(0, 10);
}

// In-place edit modal for a รายจ่าย row — so the daybook is a self-contained
// workspace and editing never leaves the page (owner 2026-06-29). Covers the
// fields that matter for an existing bill; OCR/doc-attach live on the รายจ่าย page.
export default function ExpenseEditModal({
  expense, categories, vendors, paymentMethods, mode = "edit", onClose, onSaved
}: {
  expense: EditableExpense;
  categories: Array<{ code: string | null; name: string }>;
  vendors: Array<{ name: string; tax_id: string | null; last_description?: string | null; last_bill?: VendorLastBill | null }>;
  paymentMethods: Array<{ id: number; name: string }>;
  mode?: "edit" | "create";
  onClose: () => void;
  onSaved: (savedDate?: string) => void;
}) {
  const isCreate = mode === "create";
  const [vendor, setVendor] = useState(expense.vendor_name ?? "");
  const [invoiceNo, setInvoiceNo] = useState(expense.invoice_no ?? "");
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
  const [whtRate, setWhtRate] = useState(String(expense.wht_rate ?? 0));
  const [awaitingDoc, setAwaitingDoc] = useState(!!expense.awaiting_doc);
  const [isFixed, setIsFixed] = useState(!!expense.is_fixed);
  const [status, setStatus] = useState<"paid" | "unpaid">(expense.payment_status);
  const [method, setMethod] = useState(expense.payment_method ?? (paymentMethods[0]?.name ?? ""));
  const [paidDate, setPaidDate] = useState(expense.paid_date ?? expense.bill_date);
  const [dueDate, setDueDate] = useState(expense.due_date ?? "");
  const [dueMode, setDueMode] = useState<"" | "on_receipt" | "cycle" | "date">(
    (expense.due_mode as "on_receipt" | "cycle" | "date" | null) ?? (expense.due_date ? "date" : ""));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // New-vendor prompt (owner 2026-07-06): when the typed ผู้จำหน่าย isn't in the
  // branch master, ask for เลขผู้เสียภาษี + รอบจ่าย and add it to the master.
  const knownVendor = (name: string) => {
    const n = name.trim().toLowerCase();
    return !n || vendors.some((v) => v.name.trim().toLowerCase() === n);
  };
  const handledVendors = useRef<Set<string>>(new Set());
  // Last vendor whose bill we auto-prefilled — so re-typing the same name doesn't
  // clobber edits the user made after the first prefill.
  const prefilledRef = useRef<string | null>(null);
  const [nvName, setNvName] = useState<string | null>(null);  // pending prompt (null = closed)
  const [nvTaxId, setNvTaxId] = useState("");
  const [nvCycle, setNvCycle] = useState("");
  const [nvBusy, setNvBusy] = useState(false);
  const [nvErr, setNvErr] = useState<string | null>(null);

  function maybePromptVendor(name: string) {
    const n = name.trim();
    if (!n || knownVendor(n) || handledVendors.current.has(n.toLowerCase())) return;
    setNvName(n); setNvTaxId(""); setNvCycle(""); setNvErr(null);
  }

  async function saveNewVendor(skip: boolean) {
    const name = (nvName ?? "").trim();
    handledVendors.current.add(name.toLowerCase());   // don't re-prompt this name
    if (skip || !name) { setNvName(null); return; }
    setNvBusy(true); setNvErr(null);
    try {
      const res = await fetch(apiUrl("/api/accounta/vendors"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, tax_id: nvTaxId.trim() || null, pay_cycle: nvCycle.trim() || null })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setNvErr(humanizeApiError(j, "บันทึกผู้จำหน่ายไม่สำเร็จ")); return; }
      setNvName(null);
    } catch { setNvErr("เชื่อมต่อไม่ได้ — ลองอีกครั้ง"); }
    finally { setNvBusy(false); }
  }

  const isCapex = categories.find((c) => c.name === category)?.code === CAPEX_CATEGORY_CODE;
  const total = parseMoney(amount) || 0;
  const vat = vatOverride.trim() !== ""
    ? round2(Number(vatOverride) || 0)
    : (hasVat ? splitVat(round2(total), true).vat : 0);
  // Withholding tax (หัก ณ ที่จ่าย): computed on the ex-VAT base × rate.
  // Cash actually paid to the vendor = total − wht; the withheld amount is remitted (ภ.ง.ด.3).
  const whtRateNum = Number(whtRate) || 0;
  const whtBase = round2(total - vat);
  const whtAmount = round2(whtBase * whtRateNum);
  const netPay = round2(total - whtAmount);

  async function save() {
    if (!Number.isFinite(total) || total <= 0) { setErr("กรอกยอดเงินให้ถูกต้อง"); return; }
    // If the ผู้จำหน่าย is new (not in the master, not yet handled), capture its
    // เลขผู้เสียภาษี + รอบจ่าย first — then the admin taps บันทึก again.
    if (vendor.trim() && !knownVendor(vendor) && !handledVendors.current.has(vendor.trim().toLowerCase())) {
      maybePromptVendor(vendor); return;
    }
    setBusy(true); setErr(null);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const body = {
        branch_id: expense.branch_id, company_id: expense.company_id,
        bill_date: billDate, vendor_name: vendor.trim() || null, invoice_no: invoiceNo.trim() || null,
        doc_type: docType || null, category: category || null,
        capex_bucket: isCapex ? (capexBucket || null) : null,
        description: description.trim() || null, amount_total: round2(total),
        has_tax_invoice: hasVat, vat_amount: vat,
        wht_rate: whtRateNum,
        awaiting_doc: awaitingDoc,
        is_fixed: isFixed,
        payment_status: status,
        payment_method: status === "paid" ? (method || null) : null,
        paid_date: status === "paid" ? paidDate : null,
        due_date: status === "unpaid" ? (dueDate || null) : null,
        due_mode: status === "unpaid" ? (dueMode || null) : null,
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

  // Vendor is the "start here" field: on an exact match to a known คู่ค้า,
  // prefill EVERY field from its most-recent bill (owner 2026-07-24/25) — only
  // the amount is left to type. Fires once per distinct match.
  function onVendorName(v: string) {
    setVendor(v);
    const m = vendors.find((x) => x.name.trim().toLowerCase() === v.trim().toLowerCase());
    if (m && m.name !== prefilledRef.current) {
      prefilledRef.current = m.name;
      const lb = m.last_bill;
      if (lb) {
        if (lb.category != null) setCategory(lb.category);
        if (lb.description != null) setDescription(lb.description);
        if (lb.doc_type && (DOC_TYPES as readonly string[]).includes(lb.doc_type)) setDocType(lb.doc_type);
        if (lb.capex_bucket && (STARTUP_CATEGORIES as readonly string[]).includes(lb.capex_bucket)) setCapexBucket(lb.capex_bucket);
        setHasVat(!!lb.has_tax_invoice);
        setWhtRate(String(lb.wht_rate ?? 0));
        setIsFixed(!!lb.is_fixed);
        setStatus(lb.payment_status === "unpaid" ? "unpaid" : "paid");
        if (lb.payment_method) setMethod(lb.payment_method);
        if (lb.payment_status === "unpaid" && lb.due_mode) {
          const dm = lb.due_mode as "on_receipt" | "cycle" | "date";
          setDueMode(dm);
          if (dm === "cycle") setDueDate(nextMonday(billDate));
        }
      } else if (m.last_description && !description.trim()) {
        setDescription(m.last_description);
      }
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/40 p-4 overflow-y-auto overscroll-contain" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl my-4 max-h-[85dvh] overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <div className="text-sm font-bold text-slate-800">{isCreate ? "เพิ่มรายจ่าย" : "แก้ไขรายจ่าย"}</div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none">✕</button>
        </div>
        {/* Vendor = "start here" — the one field to fill; the rest auto-prefills
            from its last bill (owner 2026-07-25). Made visually dominant. */}
        <div className="px-5 pt-5">
          <div className="rounded-lg border border-brand/40 bg-brand/5 p-3">
            <label className="label !text-[13px] !text-brand !font-bold !mb-1">① ผู้จำหน่าย / ผู้รับเงิน</label>
            <input className="input !text-base !py-2.5 !border-brand/50 focus:!border-brand" list="exp-edit-vendors" value={vendor}
              onChange={(e) => onVendorName(e.target.value)} placeholder="พิมพ์ชื่อคู่ค้า แล้วระบบจะเติมช่องอื่นให้" autoFocus={isCreate} />
            <datalist id="exp-edit-vendors">{vendors.map((v) => <option key={v.name} value={v.name} />)}</datalist>
            <p className="text-[11px] text-brand/80 mt-1.5">กรอกช่องนี้ช่องเดียว — ระบบดึงค่าที่ใช้บ่อยจากบิลล่าสุดมาเติมให้ เหลือแค่ใส่ยอด</p>
          </div>
        </div>
        <div className="p-5 pt-3.5 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3.5">
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

          <div>
            <label className="label !text-xs">เลขที่ใบกำกับ/บิล</label>
            <input className="input font-mono" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} placeholder="เลขที่บนบิล (เช็คบิลซ้ำ)" />
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
              <input type="number" inputMode="decimal" className="input !inline-block !w-40 !py-1"
                value={vatOverride} onChange={(e) => setVatOverride(e.target.value)}
                placeholder="แก้ไขจำนวน" title="กรอกถ้าต้องการกำหนดภาษีมูลค่าเพิ่มเอง (เว้นว่าง = คำนวณ 7%)" />
            </div>
          )}

          <div>
            <label className="label !text-xs">หัก ณ ที่จ่าย</label>
            <Select value={whtRate} onChange={setWhtRate}
              options={[
                { value: "0", label: "ไม่หัก" },
                { value: "0.01", label: "1% (ค่าขนส่ง)" },
                { value: "0.03", label: "3% (ค่าบริการ/รับจ้าง)" },
                { value: "0.05", label: "5% (ค่าเช่า)" }
              ]} />
          </div>
          {whtRateNum > 0 && (
            <div className="text-[11px] text-slate-500 self-end pb-2 leading-relaxed">
              หัก ณ ที่จ่าย <span className="text-rose-600 font-semibold">฿{fmtMoney(whtAmount)}</span>
              <span className="text-slate-400"> (ฐาน ฿{fmtMoney(whtBase)})</span><br />
              จ่ายจริงให้ผู้ขาย <span className="text-slate-800 font-semibold">฿{fmtMoney(netPay)}</span>
            </div>
          )}

          <div>
            <label className="label !text-xs">สถานะ</label>
            <Select value={status} onChange={(v) => setStatus(v as "paid" | "unpaid")}
              options={[{ value: "paid", label: "ชำระแล้ว" }, { value: "unpaid", label: "ค้างชำระ (เครดิตเทอม)" }]} />
          </div>
          {status === "paid" ? (
            <div className="sm:col-span-2">
              <label className="label !text-xs">จ่ายโดย</label>
              <Select value={method} onChange={setMethod} placeholder="— เลือก —"
                options={[
                  ...(method && !paymentMethods.some((m) => m.name === method) ? [{ value: method, label: method }] : []),
                  ...paymentMethods.map((m) => ({ value: m.name, label: m.name }))
                ]} />
            </div>
          ) : (
            <div className="sm:col-span-2">
              <label className="label !text-xs">กำหนดชำระ (เครดิตเทอม)</label>
              <div className="flex flex-wrap gap-2">
                {([
                  ["on_receipt", "ชำระหลังได้รับสินค้า"],
                  ["cycle", `ชำระวันจันทร์ถัดไป${dueMode === "cycle" ? ` (${nextMonday(billDate)})` : ""}`],
                  ["date", "ระบุวันครบกำหนด"]
                ] as const).map(([mode, label]) => (
                  <button key={mode} type="button"
                    onClick={() => { setDueMode(mode); setDueDate(mode === "cycle" ? nextMonday(billDate) : mode === "on_receipt" ? "" : dueDate); }}
                    className={`px-3.5 py-2 rounded-full text-sm font-medium border transition ${
                      dueMode === mode ? "bg-brand text-white border-brand" : "bg-white border-slate-300 text-slate-500 hover:bg-slate-50"}`}>
                    {dueMode === mode ? "✓ " : ""}{label}
                  </button>
                ))}
              </div>
              {dueMode === "date" && (
                <input type="date" className="input sm:w-1/2 mt-2" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              )}
            </div>
          )}
          {status === "paid" && (
            <div>
              <label className="label !text-xs">วันที่เงินออกจริง</label>
              <input type="date" className="input" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} />
            </div>
          )}

          <div className="sm:col-span-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => setAwaitingDoc(!awaitingDoc)}
              title="จ่าย/ลงบัญชีก่อน — ค่อยตามใบเสร็จ/ใบกำกับภาษีทีหลัง"
              className={`px-3.5 py-2 rounded-full text-sm font-medium border transition ${
                awaitingDoc ? "bg-amber-100 border-amber-400 text-amber-800" : "bg-white border-slate-300 text-slate-500 hover:bg-slate-50"}`}>
              {awaitingDoc ? "✓ " : ""}ยังไม่ได้รับเอกสาร
            </button>
            <button type="button" onClick={() => setIsFixed(!isFixed)}
              title="นับเข้าจุดคุ้มทุนแบบต้นทุนคงที่ (ไม่เลือก = รายจ่ายแปรผัน)"
              className={`px-3.5 py-2 rounded-full text-sm font-medium border transition ${
                isFixed ? "bg-indigo-100 border-indigo-400 text-indigo-800" : "bg-white border-slate-300 text-slate-500 hover:bg-slate-50"}`}>
              {isFixed ? "✓ " : ""}ต้นทุนคงที่/รายจ่ายประจำ
            </button>
          </div>

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

      {nvName !== null && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={(e) => e.stopPropagation()}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm">
            <div className="px-4 py-3 border-b border-slate-100">
              <div className="text-sm font-bold text-slate-800">ผู้จำหน่ายรายใหม่</div>
              <div className="text-xs text-slate-500 mt-0.5 truncate">“{nvName}” ยังไม่มีในระบบ — บันทึกข้อมูลไว้ใช้ครั้งต่อไป</div>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label className="label !text-xs">เลขผู้เสียภาษี (ถ้ามี)</label>
                <input className="input font-mono" inputMode="numeric" value={nvTaxId}
                  onChange={(e) => setNvTaxId(e.target.value)} placeholder="13 หลัก" />
              </div>
              <div>
                <label className="label !text-xs">รอบจ่าย (ถ้ามี)</label>
                <input className="input" value={nvCycle} onChange={(e) => setNvCycle(e.target.value)}
                  placeholder="เช่น ทุกวันที่ 5 / สิ้นเดือน / เครดิต 30 วัน" />
              </div>
              {nvErr && <div className="text-xs text-rose-600">{nvErr}</div>}
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-100">
              <button type="button" onClick={() => saveNewVendor(true)} disabled={nvBusy}
                className="rounded-md border border-slate-300 bg-white text-slate-600 px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">
                ข้าม
              </button>
              <button type="button" onClick={() => saveNewVendor(false)} disabled={nvBusy}
                className="rounded-md bg-brand text-white px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50">
                {nvBusy ? "กำลังบันทึก…" : "บันทึกผู้จำหน่าย"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
