"use client";

import { useState, useRef, useTransition, useMemo } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";
import { formatLongDate } from "@/lib/time";
import { humanizeApiError } from "@/lib/error-messages";
import {
  PAYMENT_STATUS_LABEL, splitVat, round2,
  type PaymentStatus, type OcrBillResult
} from "@/lib/accounta";

type Ref = { id: number; name: string };
type Category = { id: number; code: string | null; name: string };
type Method = { id: number; name: string };
type Vendor = { id: number; name: string; tax_id: string | null; category: string | null };
type Expense = {
  id: number; branch_id: number | null; branch_name: string | null;
  company_id: number | null; company_name: string | null;
  bill_date: string; vendor_id: number | null; vendor_name: string | null;
  category: string | null; description: string | null;
  amount_total: number; has_tax_invoice: number; vat_amount: number; base_amount: number;
  payment_status: PaymentStatus; payment_method: string | null; paid_date: string | null;
  has_doc: boolean; ocr_source: string | null; ocr_cost_baht: number | null; note: string | null;
};
type Summary = {
  month: string;
  accrual: { count: number; base: number; vat: number; total: number };
  cash: { count: number; total: number };
  inputVat: number; unpaidTotal: number; unpaidCount: number;
};
type Usage = { monthCount: number; monthBaht: number; totalCount: number; totalBaht: number };

type FormState = {
  id: number | null;
  branch_id: string; company_id: string;
  bill_date: string; vendor_name: string; category: string; description: string;
  amount_total: string; has_tax_invoice: boolean; vat_override: string;
  payment_status: PaymentStatus; payment_method: string; paid_date: string;
  note: string;
  rememberVendor: boolean;
};

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function blankForm(defaultMethod = ""): FormState {
  return {
    id: null, branch_id: "", company_id: "",
    bill_date: todayISO(), vendor_name: "", category: "", description: "",
    amount_total: "", has_tax_invoice: false, vat_override: "",
    payment_status: "paid", payment_method: defaultMethod, paid_date: todayISO(),
    note: "", rememberVendor: true
  };
}

export default function ExpensesClient(props: {
  month: string;
  branches: Ref[];
  companies: Ref[];
  vendors: Vendor[];
  categories: Category[];
  paymentMethods: Method[];
  initialExpenses: Expense[];
  initialSummary: Summary;
  ocrAvailable: boolean;
  ocrUsage: Usage;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [month, setMonth] = useState(props.month);
  const [branchId, setBranchId] = useState<string>("");
  const [companyId, setCompanyId] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<"" | PaymentStatus>("");
  const [expenses, setExpenses] = useState<Expense[]>(props.initialExpenses);
  const [summary, setSummary] = useState<Summary>(props.initialSummary);
  const [vendors, setVendors] = useState<Vendor[]>(props.vendors);
  const [categories, setCategories] = useState<Category[]>(props.categories);
  const [methods, setMethods] = useState<Method[]>(props.paymentMethods);
  const [usage, setUsage] = useState<Usage>(props.ocrUsage);

  // Inline "+ add" state for the category / payment-method pickers.
  const [newCat, setNewCat] = useState<string | null>(null);   // null = closed
  const [newMethod, setNewMethod] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<FormState>(blankForm(props.paymentMethods[0]?.name ?? ""));
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  // Receipt file staged in the add/edit modal (uploaded after save). The
  // OCR scan reuses the same file as the receipt.
  const fileRef = useRef<HTMLInputElement>(null);
  const ocrInputRef = useRef<HTMLInputElement>(null);
  const [stagedFile, setStagedFile] = useState<File | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);

  // Live VAT split preview for the form.
  const vatPreview = useMemo(() => {
    const total = Number(form.amount_total) || 0;
    if (form.vat_override.trim() !== "") {
      const vat = round2(Number(form.vat_override) || 0);
      return { vat, base: round2(total - vat) };
    }
    return splitVat(total, form.has_tax_invoice);
  }, [form.amount_total, form.has_tax_invoice, form.vat_override]);

  async function reload(next?: { month?: string; branch?: string; company?: string; status?: "" | PaymentStatus }) {
    const m = next?.month ?? month;
    const b = next?.branch ?? branchId;
    const co = next?.company ?? companyId;
    const s = next?.status ?? statusFilter;
    setBusy(true); setErr(null);
    try {
      const q = new URLSearchParams({ month: m });
      if (b) q.set("branch", b);
      if (co) q.set("company", co);
      if (s) q.set("status", s);
      const res = await fetch(apiUrl(`/api/accounta/expenses?${q.toString()}`));
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "โหลดข้อมูลไม่สำเร็จ")); return; }
      setExpenses(j.expenses); setSummary(j.summary);
    } finally { setBusy(false); }
  }

  function openAdd() {
    setForm(blankForm(methods[0]?.name ?? ""));
    setStagedFile(null);
    setScanMsg(null);
    setNewCat(null); setNewMethod(null);
    setErr(null);
    setModalOpen(true);
  }

  function openEdit(e: Expense) {
    setForm({
      id: e.id,
      branch_id: e.branch_id != null ? String(e.branch_id) : "",
      company_id: e.company_id != null ? String(e.company_id) : "",
      bill_date: e.bill_date,
      vendor_name: e.vendor_name ?? "",
      category: e.category ?? "",
      description: e.description ?? "",
      amount_total: String(e.amount_total),
      has_tax_invoice: !!e.has_tax_invoice,
      vat_override: "",
      payment_status: e.payment_status,
      payment_method: e.payment_method || (methods[0]?.name ?? ""),
      paid_date: e.paid_date ?? e.bill_date,
      note: e.note ?? "",
      rememberVendor: false
    });
    setStagedFile(null);
    setScanMsg(null);
    setNewCat(null); setNewMethod(null);
    setErr(null);
    setModalOpen(true);
  }

  async function runOcr(file: File) {
    setScanning(true); setScanMsg("กำลังอ่านบิล…"); setErr(null);
    try {
      const fd = new FormData();
      fd.append("image", file);
      const res = await fetch(apiUrl("/api/accounta/ocr"), { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setScanMsg(null); setErr(humanizeApiError(j, "อ่านบิลไม่สำเร็จ")); return; }
      const r = j.result as OcrBillResult;
      setForm((f) => ({
        ...f,
        vendor_name: r.vendor_name ?? f.vendor_name,
        bill_date: r.bill_date ?? f.bill_date,
        amount_total: r.amount_total != null ? String(r.amount_total) : f.amount_total,
        has_tax_invoice: r.has_tax_invoice ?? f.has_tax_invoice,
        vat_override: r.vat_amount != null ? String(r.vat_amount) : f.vat_override,
        category: r.category && categories.some((c) => c.name === r.category) ? r.category : f.category,
        description: r.description ?? f.description,
        paid_date: r.bill_date ?? f.paid_date
      }));
      setStagedFile(file); // keep the scan as the receipt
      if (j.usage) setUsage(j.usage);
      setScanMsg(`อ่านแล้ว (สแกนนี้ ~฿${fmtMoney(j.costBaht ?? 0)}) — ตรวจทานก่อนบันทึก`);
    } finally { setScanning(false); }
  }

  async function save() {
    const total = Number(form.amount_total);
    if (!form.amount_total || !Number.isFinite(total) || total <= 0) {
      setErr("กรอกยอดเงินให้ถูกต้อง"); return;
    }
    setBusy(true); setErr(null);
    try {
      const matchVendor = vendors.find(
        (v) => v.name.toLowerCase() === form.vendor_name.trim().toLowerCase()
      );
      const body = {
        branch_id: form.branch_id ? Number(form.branch_id) : null,
        company_id: form.company_id ? Number(form.company_id) : null,
        bill_date: form.bill_date,
        vendor_id: matchVendor?.id ?? null,
        vendor_name: form.vendor_name.trim() || null,
        category: form.category || null,
        description: form.description.trim() || null,
        amount_total: total,
        has_tax_invoice: form.has_tax_invoice,
        vat_amount: form.vat_override.trim() !== "" ? round2(Number(form.vat_override) || 0)
          : (form.has_tax_invoice ? splitVat(total, true).vat : 0),
        payment_status: form.payment_status,
        payment_method: form.payment_status === "paid" ? form.payment_method : null,
        paid_date: form.payment_status === "paid" ? form.paid_date : null,
        note: form.note.trim() || null
      };
      const url = form.id ? `/api/accounta/expenses/${form.id}` : "/api/accounta/expenses";
      const res = await fetch(apiUrl(url), {
        method: form.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "บันทึกไม่สำเร็จ")); return; }
      const expenseId = form.id ?? j.id;

      // Remember a new vendor for next time (de-duped server-side).
      if (!matchVendor && form.rememberVendor && form.vendor_name.trim()) {
        try {
          const vr = await fetch(apiUrl("/api/accounta/vendors"), {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: form.vendor_name.trim(), category: form.category || null })
          });
          const vj = await vr.json().catch(() => ({}));
          if (vj.ok) setVendors((vs) => [...vs, { id: vj.id, name: form.vendor_name.trim(), tax_id: null, category: form.category || null }]);
        } catch { /* non-fatal */ }
      }

      // Attach the receipt image (staged file or OCR scan) if present.
      if (stagedFile && expenseId) {
        const fd = new FormData();
        fd.append("image", stagedFile);
        await fetch(apiUrl(`/api/accounta/expenses/${expenseId}/doc`), { method: "POST", body: fd }).catch(() => {});
      }

      setModalOpen(false);
      await reload();
      startTransition(() => router.refresh());
    } finally { setBusy(false); }
  }

  async function remove(e: Expense) {
    if (!window.confirm(`ลบรายจ่าย "${e.vendor_name ?? e.description ?? "รายการนี้"}" ฿${fmtMoney(e.amount_total)} ? กู้คืนไม่ได้`)) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/accounta/expenses/${e.id}`), { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "ลบไม่สำเร็จ")); return; }
      await reload();
    } finally { setBusy(false); }
  }

  async function addCategory() {
    const name = (newCat ?? "").trim();
    if (!name) { setNewCat(null); return; }
    try {
      const res = await fetch(apiUrl("/api/accounta/categories"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      const j = await res.json().catch(() => ({}));
      if (j.ok) { setCategories(j.categories); set("category", name); }
    } finally { setNewCat(null); }
  }

  async function addMethod() {
    const name = (newMethod ?? "").trim();
    if (!name) { setNewMethod(null); return; }
    try {
      const res = await fetch(apiUrl("/api/accounta/payment-methods"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      const j = await res.json().catch(() => ({}));
      if (j.ok) { setMethods(j.methods); set("payment_method", name); }
    } finally { setNewMethod(null); }
  }

  const filtered = statusFilter ? expenses.filter((e) => e.payment_status === statusFilter) : expenses;

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={openAdd} disabled={busy} className="btn-primary disabled:opacity-50">
          + เพิ่มรายจ่าย
        </button>
        <input type="month" className="input !w-auto" value={month}
          onChange={(e) => { setMonth(e.target.value); reload({ month: e.target.value }); }} />
        <select className="input !w-auto" value={companyId}
          onChange={(e) => { setCompanyId(e.target.value); reload({ company: e.target.value }); }}>
          <option value="">ทุกบริษัท</option>
          {props.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="input !w-auto" value={branchId}
          onChange={(e) => { setBranchId(e.target.value); reload({ branch: e.target.value }); }}>
          <option value="">ทุกสาขา</option>
          {props.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <select className="input !w-auto" value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as "" | PaymentStatus)}>
          <option value="">ทุกสถานะ</option>
          <option value="paid">ชำระแล้ว</option>
          <option value="unpaid">ค้างชำระ</option>
        </select>
      </div>

      {err && <p className="text-sm text-rose-600">{err}</p>}

      {/* Summary — accrual vs cash flow + outstanding */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="card space-y-1">
          <div className="text-[11px] tracking-wide text-slate-400">ตามบิล (เดือนนี้)</div>
          <div className="text-2xl font-bold text-slate-800">฿{fmtMoney(summary.accrual.total)}</div>
          <div className="text-xs text-slate-500">
            ฐาน ฿{fmtMoney(summary.accrual.base)} · ภาษีซื้อ <span className="text-brand font-semibold">฿{fmtMoney(summary.inputVat)}</span> · {summary.accrual.count} บิล
          </div>
        </div>
        <div className="card space-y-1">
          <div className="text-[11px] tracking-wide text-slate-400">กระแสเงินสด (เงินออกเดือนนี้)</div>
          <div className="text-2xl font-bold text-slate-800">฿{fmtMoney(summary.cash.total)}</div>
          <div className="text-xs text-slate-500">{summary.cash.count} รายการที่จ่ายจริงในเดือนนี้</div>
        </div>
        <div className="card space-y-1">
          <div className="text-[11px] tracking-wide text-slate-400">ค้างชำระ (คงค้างรวม)</div>
          <div className={`text-2xl font-bold ${summary.unpaidTotal > 0 ? "text-amber-600" : "text-slate-800"}`}>
            ฿{fmtMoney(summary.unpaidTotal)}
          </div>
          <div className="text-xs text-slate-500">{summary.unpaidCount} บิลรอชำระ</div>
        </div>
      </div>

      {props.ocrAvailable && (
        <p className="text-[11px] text-slate-400">
          OCR สแกนบิล: เดือนนี้ {usage.monthCount} ครั้ง ~฿{fmtMoney(usage.monthBaht)} · รวมทั้งหมด {usage.totalCount} ครั้ง ~฿{fmtMoney(usage.totalBaht)} (ประมาณการ)
        </p>
      )}

      {/* List */}
      {filtered.length === 0 ? (
        <div className="card text-center py-10 text-slate-500">
          ยังไม่มีรายจ่ายในเดือนนี้ — กด “เพิ่มรายจ่าย” เพื่อเริ่มลงบิล
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-slate-400 border-b border-slate-100">
                <th className="px-3 py-2">วันที่บิล</th>
                <th className="px-3 py-2">ผู้ค้า / รายการ</th>
                <th className="px-3 py-2">หมวด</th>
                <th className="px-3 py-2 text-right">ยอดรวม</th>
                <th className="px-3 py-2 text-right">ภาษีซื้อ</th>
                <th className="px-3 py-2">สถานะ</th>
                <th className="px-3 py-2">จ่ายโดย</th>
                <th className="px-3 py-2">เงินออก</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => (
                <tr key={e.id} className="border-b border-slate-50 hover:bg-slate-50/60">
                  <td className="px-3 py-2 whitespace-nowrap text-slate-600">
                    {formatLongDate(e.bill_date, "th")}
                    {e.branch_name && <div className="text-[10px] text-slate-400">{e.branch_name}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-800">{e.vendor_name || "—"}</div>
                    {e.description && <div className="text-[11px] text-slate-500">{e.description}</div>}
                    {e.has_doc && (
                      <a href={apiUrl(`/api/accounta/expenses/${e.id}/doc`)} target="_blank" rel="noreferrer"
                        className="text-[11px] text-brand hover:underline">ดูบิล</a>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-500 text-xs">{e.category || "—"}</td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-800 whitespace-nowrap">฿{fmtMoney(e.amount_total)}</td>
                  <td className="px-3 py-2 text-right text-slate-500 whitespace-nowrap">
                    {e.vat_amount > 0 ? `฿${fmtMoney(e.vat_amount)}` : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                      e.payment_status === "paid" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
                      {PAYMENT_STATUS_LABEL[e.payment_status]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">{e.payment_status === "paid" ? (e.payment_method || "—") : "—"}</td>
                  <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">
                    {e.payment_status === "paid" && e.paid_date ? formatLongDate(e.paid_date, "th") : "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">
                    <button type="button" onClick={() => openEdit(e)} disabled={busy}
                      className="text-xs text-slate-500 hover:text-brand">แก้</button>
                    <button type="button" onClick={() => remove(e)} disabled={busy}
                      className="text-xs text-slate-400 hover:text-rose-600 ml-3">ลบ</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add / edit modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-4"
          onClick={() => !busy && setModalOpen(false)}>
          <div className="card w-full max-w-2xl my-8 space-y-3" onClick={(ev) => ev.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-slate-800">{form.id ? "แก้ไขรายจ่าย" : "เพิ่มรายจ่าย"}</h3>
              <button type="button" onClick={() => setModalOpen(false)} className="text-slate-400 hover:text-slate-700">✕</button>
            </div>

            {props.ocrAvailable && !form.id && (
              <div className="rounded-lg border border-dashed border-brand/40 bg-brand/5 p-3 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <button type="button" disabled={scanning}
                    onClick={() => ocrInputRef.current?.click()}
                    className="btn-secondary !py-1.5 disabled:opacity-50">
                    {scanning ? "กำลังอ่าน…" : "ถ่ายรูป / อัปโหลดบิล แล้วกรอกให้อัตโนมัติ"}
                  </button>
                  <span className="text-[11px] text-slate-500">ตรวจทานตัวเลขทุกครั้งก่อนบันทึก</span>
                </div>
                {scanMsg && <p className="text-[11px] text-emerald-700">{scanMsg}</p>}
                <input ref={ocrInputRef} type="file" accept="image/*" capture="environment" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) runOcr(f); e.target.value = ""; }} />
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label !text-xs">สาขา</label>
                <select className="input" value={form.branch_id} onChange={(e) => set("branch_id", e.target.value)}>
                  <option value="">— ไม่ระบุ —</option>
                  {props.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label !text-xs">บริษัท (สำหรับภาษี)</label>
                <select className="input" value={form.company_id} onChange={(e) => set("company_id", e.target.value)}>
                  <option value="">— ไม่ระบุ —</option>
                  {props.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label !text-xs">วันที่บิล</label>
                <input type="date" className="input" value={form.bill_date} onChange={(e) => set("bill_date", e.target.value)} />
              </div>
              <div>
                <label className="label !text-xs">หมวดหมู่</label>
                {newCat === null ? (
                  <select className="input" value={form.category}
                    onChange={(e) => { if (e.target.value === "__add__") setNewCat(""); else set("category", e.target.value); }}>
                    <option value="">— เลือก —</option>
                    {categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                    <option value="__add__">+ เพิ่มประเภทใหม่…</option>
                  </select>
                ) : (
                  <div className="flex gap-1">
                    <input className="input" autoFocus value={newCat} onChange={(e) => setNewCat(e.target.value)}
                      placeholder="ชื่อประเภทใหม่"
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCategory(); } }} />
                    <button type="button" className="btn-secondary !px-2" onClick={addCategory}>เพิ่ม</button>
                    <button type="button" className="btn-secondary !px-2" onClick={() => setNewCat(null)}>✕</button>
                  </div>
                )}
              </div>
              <div className="sm:col-span-2">
                <label className="label !text-xs">ผู้ค้า / ผู้รับเงิน</label>
                <input className="input" list="accounta-vendors" value={form.vendor_name}
                  onChange={(e) => set("vendor_name", e.target.value)} placeholder="พิมพ์ชื่อ หรือเลือกจากรายการ" />
                <datalist id="accounta-vendors">
                  {vendors.map((v) => <option key={v.id} value={v.name} />)}
                </datalist>
              </div>
              <div className="sm:col-span-2">
                <label className="label !text-xs">รายละเอียด</label>
                <input className="input" value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="เช่น ค่าวัสดุสำนักงานประจำเดือน" />
              </div>
            </div>

            {/* Amount + VAT */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
              <div>
                <label className="label !text-xs">ยอดรวมที่จ่าย (รวม VAT)</label>
                <input type="number" inputMode="decimal" className="input" value={form.amount_total}
                  onChange={(e) => set("amount_total", e.target.value)} placeholder="0.00" />
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-600 pb-2">
                <input type="checkbox" checked={form.has_tax_invoice}
                  onChange={(e) => set("has_tax_invoice", e.target.checked)} />
                มีใบกำกับภาษีเต็มรูป (แยก VAT 7%)
              </label>
            </div>
            {Number(form.amount_total) > 0 && (
              <div className="text-xs text-slate-500 -mt-1">
                ฐานภาษี ฿{fmtMoney(vatPreview.base)} · ภาษีซื้อ <span className="text-brand font-semibold">฿{fmtMoney(vatPreview.vat)}</span>
                {form.has_tax_invoice && (
                  <input type="number" inputMode="decimal" className="input !inline-block !w-28 !py-1 ml-2 align-middle"
                    value={form.vat_override} onChange={(e) => set("vat_override", e.target.value)}
                    placeholder="แก้ VAT" title="กรอกถ้าต้องการกำหนด VAT เอง (เว้นว่าง = คำนวณ 7%)" />
                )}
              </div>
            )}

            {/* Payment */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
              <div>
                <label className="label !text-xs">สถานะ</label>
                <select className="input" value={form.payment_status}
                  onChange={(e) => set("payment_status", e.target.value as PaymentStatus)}>
                  <option value="paid">ชำระแล้ว</option>
                  <option value="unpaid">ค้างชำระ (เครดิตเทอม)</option>
                </select>
              </div>
              {form.payment_status === "paid" && (
                <>
                  <div>
                    <label className="label !text-xs">จ่ายโดย</label>
                    {newMethod === null ? (
                      <select className="input" value={form.payment_method}
                        onChange={(e) => { if (e.target.value === "__add__") setNewMethod(""); else set("payment_method", e.target.value); }}>
                        {methods.map((m) => <option key={m.id} value={m.name}>{m.name}</option>)}
                        <option value="__add__">+ เพิ่มช่องทาง…</option>
                      </select>
                    ) : (
                      <div className="flex gap-1">
                        <input className="input" autoFocus value={newMethod} onChange={(e) => setNewMethod(e.target.value)}
                          placeholder="เช่น บัตรเครดิตกรรมการ ธนาคาร ก."
                          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addMethod(); } }} />
                        <button type="button" className="btn-secondary !px-2" onClick={addMethod}>เพิ่ม</button>
                        <button type="button" className="btn-secondary !px-2" onClick={() => setNewMethod(null)}>✕</button>
                      </div>
                    )}
                  </div>
                  <div>
                    <label className="label !text-xs">วันที่เงินออกจริง</label>
                    <input type="date" className="input" value={form.paid_date} onChange={(e) => set("paid_date", e.target.value)} />
                  </div>
                </>
              )}
            </div>
            {form.payment_status === "paid" && form.payment_method.includes("เครดิต") && (
              <p className="text-[11px] text-slate-400 -mt-1">
                บัตรเครดิต: ลงบิลตามวันที่บิล แต่ “วันที่เงินออกจริง” คือรอบตัดบัตร (อาจเป็นเดือนถัดไป) — แยกในมุมมองกระแสเงินสด
              </p>
            )}

            <div>
              <label className="label !text-xs">หมายเหตุ</label>
              <input className="input" value={form.note} onChange={(e) => set("note", e.target.value)} />
            </div>

            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-3 text-xs text-slate-500">
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={form.rememberVendor} onChange={(e) => set("rememberVendor", e.target.checked)} />
                  จำผู้ค้านี้
                </label>
                <button type="button" onClick={() => fileRef.current?.click()} className="hover:text-brand">
                  {stagedFile ? `แนบบิล: ${stagedFile.name.slice(0, 20)}` : "แนบรูปบิล"}
                </button>
                <input ref={fileRef} type="file" accept="image/*" className="hidden"
                  onChange={(e) => setStagedFile(e.target.files?.[0] ?? null)} />
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setModalOpen(false)} className="btn-secondary" disabled={busy}>ยกเลิก</button>
                <button type="button" onClick={save} className="btn-primary disabled:opacity-50" disabled={busy}>
                  {busy ? "กำลังบันทึก…" : "บันทึก"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
