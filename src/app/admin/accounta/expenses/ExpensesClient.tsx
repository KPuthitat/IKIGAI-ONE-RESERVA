"use client";

import { Fragment, useState, useRef, useTransition, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";
import { formatLongDate } from "@/lib/time";
import { humanizeApiError } from "@/lib/error-messages";
import {
  PAYMENT_STATUS_LABEL, splitVat, round2, splitMixedBill, CAPEX_CATEGORY_CODE,
  DOC_TYPES, DOC_TYPE_LABEL, docTypeLabel,
  type PaymentStatus, type OcrBillResult
} from "@/lib/accounta";
import { STARTUP_CATEGORIES, STARTUP_CATEGORY_LABEL } from "@/lib/feasibility";
import Combobox from "@/app/components/Combobox";
import { useConfirm } from "@/app/components/useConfirm";

// POST/PATCH JSON with a hard timeout + session-expiry detection so a save can
// never hang on "กำลังบันทึก…" silently (owner 2026-06-28). Throws Error("session")
// when the request was redirected to /login (session expired), Error("timeout")
// when it exceeds the deadline, or Error("network") on a transport failure.
async function submitJson(url: string, method: "POST" | "PATCH", body: unknown): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(apiUrl(url), {
      method, headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: ctrl.signal
    });
    if (res.redirected && /\/login(\?|$)/.test(res.url)) throw new Error("session");
    return res;
  } catch (e) {
    if (e instanceof Error && e.message === "session") throw e;
    throw new Error((e as { name?: string })?.name === "AbortError" ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
  }
}
function submitErrMsg(e: unknown): string | null {
  const m = e instanceof Error ? e.message : "";
  if (m === "session") return "เซสชันหมดอายุ — กรุณาเข้าสู่ระบบใหม่แล้วลองบันทึกอีกครั้ง (ข้อมูลที่กรอกยังอยู่)";
  if (m === "timeout") return "บันทึกใช้เวลานานเกินไป (เซิร์ฟเวอร์อาจกำลังประมวลผลอื่นอยู่) — ลองอีกครั้ง";
  if (m === "network") return "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ตรวจอินเทอร์เน็ตแล้วลองอีกครั้ง";
  return null;
}

type Ref = { id: number; name: string };
type Category = {
  id: number; code: string | null; name: string;
  description?: string | null; target_pct_min?: number | null; target_pct_max?: number | null;
};
type BudgetItem = {
  code: string | null; name: string; description: string | null;
  spent: number; pct: number | null; targetMin: number | null; targetMax: number | null;
  status: "over" | "under" | "ok" | "na";
};
type Budget = {
  month: string; revenue: number; totalExpense: number;
  items: BudgetItem[]; uncategorized: number;
};
type Method = { id: number; name: string };
type Vendor = { id: number; name: string; tax_id: string | null; category: string | null };
type Expense = {
  id: number; branch_id: number | null; branch_name: string | null;
  company_id: number | null; company_name: string | null;
  bill_date: string; vendor_id: number | null; vendor_name: string | null; invoice_no: string | null;
  doc_type: string | null; category: string | null; capex_bucket: string | null; description: string | null;
  amount_total: number; has_tax_invoice: number; vat_amount: number; base_amount: number; wht_rate: number;
  awaiting_doc: number; is_fixed: number;
  payment_status: PaymentStatus; payment_method: string | null; paid_date: string | null; due_date: string | null;
  has_doc: boolean; ocr_source: string | null; ocr_cost_baht: number | null; note: string | null;
  review_status?: string;   // 'draft' (จากไลน์ รอตรวจ) | 'confirmed'
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
  bill_date: string; vendor_name: string; invoice_no: string; doc_type: string; category: string; capex_bucket: string; description: string;
  amount_total: string; has_tax_invoice: boolean; vat_override: string; wht_rate: string;
  awaiting_doc: boolean; is_fixed: boolean;
  payment_status: PaymentStatus; payment_method: string; paid_date: string; due_date: string;
  note: string;
  rememberVendor: boolean;
};

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
const TH_MON = ["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
function monthLabel(ym: string): string { const [y, m] = ym.split("-").map(Number); return `${TH_MON[m]} ${y + 543}`; }
// Group expenses month → day, preserving the listing's date-desc order.
function groupExpenses<T extends { bill_date: string; amount_total: number }>(rows: T[]) {
  const mOrder: string[] = [];
  const mMap = new Map<string, Map<string, T[]>>();
  for (const e of rows) {
    const mk = e.bill_date.slice(0, 7);
    if (!mMap.has(mk)) { mMap.set(mk, new Map()); mOrder.push(mk); }
    const dMap = mMap.get(mk)!;
    if (!dMap.has(e.bill_date)) dMap.set(e.bill_date, []);
    dMap.get(e.bill_date)!.push(e);
  }
  return mOrder.map((mk) => {
    const days = [...mMap.get(mk)!.entries()].map(([date, rs]) => ({ date, total: rs.reduce((s, x) => s + x.amount_total, 0), rows: rs }));
    return { month: mk, total: days.reduce((s, d) => s + d.total, 0), days };
  });
}

function blankForm(defaultMethod = ""): FormState {
  return {
    id: null, branch_id: "", company_id: "",
    bill_date: todayISO(), vendor_name: "", invoice_no: "", doc_type: "", category: "", capex_bucket: "", description: "",
    amount_total: "", has_tax_invoice: false, vat_override: "", wht_rate: "0",
    awaiting_doc: false, is_fixed: false,
    payment_status: "paid", payment_method: defaultMethod, paid_date: todayISO(), due_date: "",
    note: "", rememberVendor: true
  };
}

export default function ExpensesClient(props: {
  month: string;
  activeBranchId: number | null;
  branches: Array<Ref & { company_id: number | null }>;
  companies: Ref[];
  vendors: Vendor[];
  categories: Category[];
  paymentMethods: Method[];
  expenseChannels: string[];
  initialExpenses: Expense[];
  initialSummary: Summary;
  initialDrafts: Expense[];
  initialBudget: Budget;
  ocrAvailable: boolean;
  ocrUsage: Usage;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  // Branch-locked to the active branch (owner 2026-07-03) — the in-page branch
  // filter is gone; switch branch via the top pill like the daybook.
  const activeBranch = props.branches.find((b) => b.id === props.activeBranchId) ?? null;
  const activeCompanyId = activeBranch?.company_id ?? null;
  const activeCompanyName = activeCompanyId != null
    ? (props.companies.find((c) => c.id === activeCompanyId)?.name ?? null) : null;

  const [month, setMonth] = useState(props.month);
  const [branchId] = useState<string>(props.activeBranchId != null ? String(props.activeBranchId) : "");
  const [companyId] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<"" | PaymentStatus>("");
  const [expenses, setExpenses] = useState<Expense[]>(props.initialExpenses);
  const [summary, setSummary] = useState<Summary>(props.initialSummary);
  // LINE-submitted bills awaiting review (owner 2026-06-18). Global, not
  // scoped to the month/branch filter.
  const [drafts, setDrafts] = useState<Expense[]>(props.initialDrafts);
  // Category vs benchmark % (owner 2026-06-18).
  const { confirm, ConfirmDialog } = useConfirm();
  const [budget, setBudget] = useState<Budget>(props.initialBudget);
  // True while the modal is reviewing a draft → shows the "ยืนยันเข้าสมุด" CTA.
  const [draftMode, setDraftMode] = useState(false);
  const [vendors, setVendors] = useState<Vendor[]>(props.vendors);
  const [categories, setCategories] = useState<Category[]>(props.categories);
  const [methods, setMethods] = useState<Method[]>(props.paymentMethods);
  const [usage, setUsage] = useState<Usage>(props.ocrUsage);

  // Inline "+ add" state for the category / payment-method pickers.
  const [newCat, setNewCat] = useState<string | null>(null);   // null = closed
  const [newMethod, setNewMethod] = useState<string | null>(null);

  // Bulk CSV import (owner 2026-06-17). Preview-before-commit (owner 2026-06-27):
  // a dry run shows what WILL import; the owner confirms before any DB write,
  // since import has no undo.
  const importRef = useRef<HTMLInputElement>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  type ImportPreview = {
    willImport: number; total: number; failed: number; unresolvedBranch: number;
    dateFrom: string | null; dateTo: string | null;
    byCategory: Array<{ name: string; count: number; amount: number }>;
    sample: Array<{ bill_date: string; vendor: string | null; category: string | null; amount: number; payment_status: string }>;
    errors: Array<{ row: number; message: string }>;
  };
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<FormState>(blankForm(props.paymentMethods[0]?.name ?? ""));
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  // วันที่เงินออกจริง (paid_date) ตามวันที่เอกสารโดยปริยาย — เปลี่ยนวันที่เอกสาร
  // แล้ว paid_date เลื่อนตามให้ เว้นแต่ผู้ใช้แก้ paid_date ต่างไปเองแล้ว
  // (owner 2026-06-20). f.bill_date คือค่าเดิมก่อนแก้ จึงเทียบได้ว่ายัง "ตาม" อยู่ไหม.
  const setBillDate = (v: string) => setForm((f) => ({
    ...f,
    bill_date: v,
    paid_date: (!f.paid_date || f.paid_date === f.bill_date) ? v : f.paid_date
  }));

  // Receipt file staged in the add/edit modal (uploaded after save). The
  // OCR scan reuses the same file as the receipt.
  const fileRef = useRef<HTMLInputElement>(null);
  const ocrInputRef = useRef<HTMLInputElement>(null);
  const [stagedFile, setStagedFile] = useState<File | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  // Extra attachments (owner 2026-06-20, #3.3) — loaded when editing an
  // existing expense; the primary receipt is handled by stagedFile above.
  const [extraDocs, setExtraDocs] = useState<Array<{ id: number; doc_mime: string | null; label: string | null }>>([]);
  const [extraBusy, setExtraBusy] = useState(false);
  // Whether the row being edited has a primary scanned document — drives the
  // "ดูเอกสาร" button in the modal (owner 2026-06-24: ดูเอกสารตอนตรวจ).
  const [editingHasDoc, setEditingHasDoc] = useState(false);
  // Show the document INLINE beside the form (owner 2026-06-25: a new tab is
  // awkward — read while you key).
  const [showDoc, setShowDoc] = useState(false);
  const extraRef = useRef<HTMLInputElement>(null);
  // Mixed-bill split detected by OCR (owner 2026-06-18): when set, the form
  // offers "แยกเป็น 2 รายการ" (VAT row + non-VAT row).
  const [mixedSplit, setMixedSplit] = useState<{ vatable: number; vat: number; nonvat: number } | null>(null);

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
      if (Array.isArray(j.drafts)) setDrafts(j.drafts);
      if (j.budget) setBudget(j.budget);
    } finally { setBusy(false); }
  }

  function openAdd() {
    const f = blankForm(methods[0]?.name ?? "");
    // Lock new rows to the active branch (branch-locked page).
    if (props.activeBranchId != null) {
      f.branch_id = String(props.activeBranchId);
      if (activeCompanyId != null) f.company_id = String(activeCompanyId);
    }
    setForm(f);
    setStagedFile(null);
    setScanMsg(null); setMixedSplit(null);
    setNewCat(null); setNewMethod(null);
    setDraftMode(false);
    setExtraDocs([]);
    setEditingHasDoc(false);
    setErr(null);
    setShowDoc(false); setModalOpen(true);
  }

  function openEdit(e: Expense) {
    setDraftMode(e.review_status === "draft");
    setEditingHasDoc(!!e.has_doc);
    setForm({
      id: e.id,
      // Branch-locked: keep the row on the active branch (also assigns a
      // still-unassigned LINE draft to the current branch on confirm).
      branch_id: props.activeBranchId != null ? String(props.activeBranchId)
        : (e.branch_id != null ? String(e.branch_id) : ""),
      company_id: props.activeBranchId != null && activeCompanyId != null ? String(activeCompanyId)
        : (e.company_id != null ? String(e.company_id) : ""),
      bill_date: e.bill_date,
      vendor_name: e.vendor_name ?? "",
      invoice_no: e.invoice_no ?? "",
      // Only keep a doc_type the dropdown can actually represent — legacy/imported
      // rows may carry a non-standard value (e.g. a Thai label) that the <select>
      // can't show but would still be re-sent and rejected by z.enum on save,
      // silently blocking every edit (owner 2026-06-28). Mirror the OCR guard below.
      doc_type: e.doc_type && DOC_TYPES.includes(e.doc_type as never) ? e.doc_type : "",
      category: e.category ?? "",
      capex_bucket: e.capex_bucket && STARTUP_CATEGORIES.includes(e.capex_bucket as never) ? e.capex_bucket : "",
      description: e.description ?? "",
      amount_total: String(e.amount_total),
      has_tax_invoice: !!e.has_tax_invoice,
      vat_override: "",
      wht_rate: String(e.wht_rate ?? 0),
      awaiting_doc: !!e.awaiting_doc, is_fixed: !!e.is_fixed,
      payment_status: e.payment_status,
      payment_method: e.payment_method || (methods[0]?.name ?? ""),
      paid_date: e.paid_date ?? e.bill_date,
      due_date: e.due_date ?? "",
      note: e.note ?? "",
      // Reviewing a LINE draft: remember the vendor by default so a corrected
      // category is learned on confirm. Editing a confirmed row: off (no
      // surprise overwrite).
      rememberVendor: e.review_status === "draft"
    });
    setStagedFile(null);
    setScanMsg(null); setMixedSplit(null);
    setNewCat(null); setNewMethod(null);
    setExtraDocs([]);
    void loadExtraDocs(e.id);
    setErr(null);
    setShowDoc(false); setModalOpen(true);
  }

  async function runOcr(file: File) {
    setScanning(true); setScanMsg("กำลังอ่านเอกสาร…"); setErr(null); setMixedSplit(null);
    try {
      const fd = new FormData();
      fd.append("image", file);
      const res = await fetch(apiUrl("/api/accounta/ocr"), { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setScanMsg(null); setErr(humanizeApiError(j, "อ่านเอกสารไม่สำเร็จ")); return; }
      const r = j.result as OcrBillResult;
      // Vendor auto-match against the master (server): tax id first, then exact
      // name. When matched, use the master's canonical name + remembered category.
      const matched = (j.matched_vendor ?? null) as { id: number; name: string; category: string | null; by: string } | null;
      // Vendor memory: if OCR read a known vendor, fall back to its remembered
      // category when the bill itself didn't yield one (owner 2026-06-18).
      const known = r.vendor_name
        ? vendors.find((v) => v.name.toLowerCase() === r.vendor_name!.toLowerCase())
        : undefined;
      const ocrCat = r.category && categories.some((c) => c.name === r.category) ? r.category : null;
      const matchedCat = matched?.category && categories.some((c) => c.name === matched.category) ? matched.category : null;
      const learnedCat = known?.category && categories.some((c) => c.name === known.category)
        ? known.category : null;
      setForm((f) => ({
        ...f,
        vendor_name: matched?.name ?? r.vendor_name ?? f.vendor_name,
        invoice_no: r.invoice_no ?? f.invoice_no,
        bill_date: r.bill_date ?? f.bill_date,
        amount_total: r.amount_total != null ? String(r.amount_total) : f.amount_total,
        has_tax_invoice: r.has_tax_invoice ?? f.has_tax_invoice,
        vat_override: r.vat_amount != null ? String(r.vat_amount) : f.vat_override,
        doc_type: (r.doc_type && DOC_TYPES.includes(r.doc_type as never)) ? r.doc_type : f.doc_type,
        category: ocrCat ?? matchedCat ?? learnedCat ?? f.category,
        description: r.description ?? f.description,
        paid_date: r.bill_date ?? f.paid_date
      }));
      setStagedFile(file); // keep the scan as the receipt
      setMixedSplit(splitMixedBill(r)); // mixed bill → offer the 2-row split
      if (j.usage) setUsage(j.usage);
      const matchNote = matched ? ` · จับคู่ร้าน “${matched.name}”${matched.by === "tax_id" ? " (จากเลขผู้เสียภาษี)" : ""}` : "";
      const dup = (j.duplicate ?? null) as { vendor_name: string | null; bill_date: string; amount_total: number } | null;
      if (dup) setErr(`⚠️ บิลนี้อาจซ้ำ — เลขที่ ${r.invoice_no ?? "-"}${dup.vendor_name ? ` · ${dup.vendor_name}` : ""} ฿${fmtMoney(dup.amount_total)} บันทึกไว้แล้วเมื่อ ${dup.bill_date} (ตรวจสอบก่อนบันทึกซ้ำ)`);
      else setErr(null);
      setScanMsg(`อ่านแล้ว (สแกนนี้ ~฿${fmtMoney(j.costBaht ?? 0)})${matchNote} — ตรวจทานก่อนบันทึก`);
    } finally { setScanning(false); }
  }

  // Remember the vendor + learn its category for next time. Runs for both
  // new AND existing vendors (server upserts the category via COALESCE), so
  // correcting a known vendor's category sticks and auto-fills the next bill
  // from that vendor (owner 2026-06-18). Shared by save() + splitSave().
  async function rememberVendorIfNeeded() {
    if (!(form.rememberVendor && form.vendor_name.trim())) return;
    const vname = form.vendor_name.trim();
    try {
      const vr = await fetch(apiUrl("/api/accounta/vendors"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: vname, category: form.category || null })
      });
      const vj = await vr.json().catch(() => ({}));
      if (vj.ok) {
        setVendors((vs) => {
          const i = vs.findIndex((v) => v.name.toLowerCase() === vname.toLowerCase());
          if (i >= 0) {
            const next = [...vs];
            next[i] = { ...next[i], category: form.category || next[i].category };
            return next;
          }
          return [...vs, { id: vj.id, name: vname, tax_id: null, category: form.category || null }];
        });
      }
    } catch { /* non-fatal */ }
  }

  // Mixed bill → create TWO expenses from one scan: a VAT-able row and a
  // VAT-exempt row, sharing the same photo/vendor/date (owner 2026-06-18).
  async function splitSave() {
    if (!mixedSplit) return;
    setBusy(true); setErr(null);
    try {
      const matchVendor = vendors.find(
        (v) => v.name.toLowerCase() === form.vendor_name.trim().toLowerCase()
      );
      const notePrefix = form.note.trim() ? form.note.trim() + " · " : "";
      const common = {
        branch_id: form.branch_id ? Number(form.branch_id) : null,
        company_id: form.company_id ? Number(form.company_id) : null,
        bill_date: form.bill_date,
        vendor_id: matchVendor?.id ?? null,
        vendor_name: form.vendor_name.trim() || null,
        invoice_no: form.invoice_no.trim() || null,
        doc_type: form.doc_type || null,
        category: form.category || null,
        capex_bucket: form.capex_bucket || null,   // server drops it if category ≠ CapEx
        description: form.description.trim() || null,
        // WHT applies to each part's ex-VAT base; splitting keeps the total the same.
        wht_rate: Number(form.wht_rate) || 0,
        awaiting_doc: form.awaiting_doc,
        is_fixed: form.is_fixed,
        payment_status: form.payment_status,
        payment_method: form.payment_status === "paid" ? form.payment_method : null,
        paid_date: form.payment_status === "paid" ? form.paid_date : null,
        due_date: form.payment_status === "unpaid" ? (form.due_date || null) : null
      };
      const rows = [
        { ...common, amount_total: mixedSplit.vatable, has_tax_invoice: true, vat_amount: mixedSplit.vat, note: notePrefix + "ส่วนมี VAT" },
        { ...common, amount_total: mixedSplit.nonvat, has_tax_invoice: false, vat_amount: 0, note: notePrefix + "ส่วนไม่มี VAT" }
      ];
      const ids: number[] = [];
      for (const body of rows) {
        let res: Response;
        try { res = await submitJson("/api/accounta/expenses", "POST", body); }
        catch (e) { setErr(submitErrMsg(e) ?? "บันทึกไม่สำเร็จ"); return; }
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "บันทึกไม่สำเร็จ")); return; }
        ids.push(j.id);
      }
      await rememberVendorIfNeeded();
      // Attach the same receipt photo to both rows.
      if (stagedFile) {
        for (const id of ids) {
          const fd = new FormData();
          fd.append("image", stagedFile);
          await fetch(apiUrl(`/api/accounta/expenses/${id}/doc`), { method: "POST", body: fd }).catch(() => {});
        }
      }
      setModalOpen(false);
      await reload();
      startTransition(() => router.refresh());
    } finally { setBusy(false); }
  }

  async function save(opts?: { confirm?: boolean }) {
    const total = Number(form.amount_total);
    if (!form.amount_total || !Number.isFinite(total) || total <= 0) {
      setErr("กรอกยอดเงินให้ถูกต้อง"); return;
    }
    // Confirming a draft into the ledger requires a branch (owner: แยกสาขา).
    if (opts?.confirm && !form.branch_id) {
      setErr("เลือกสาขาก่อนยืนยันเข้าสมุด"); return;
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
        invoice_no: form.invoice_no.trim() || null,
        doc_type: form.doc_type || null,
        category: form.category || null,
        capex_bucket: form.capex_bucket || null,   // server drops it if category ≠ CapEx
        description: form.description.trim() || null,
        amount_total: total,
        has_tax_invoice: form.has_tax_invoice,
        vat_amount: form.vat_override.trim() !== "" ? round2(Number(form.vat_override) || 0)
          : (form.has_tax_invoice ? splitVat(total, true).vat : 0),
        wht_rate: Number(form.wht_rate) || 0,
        awaiting_doc: form.awaiting_doc,
        is_fixed: form.is_fixed,
        payment_status: form.payment_status,
        payment_method: form.payment_status === "paid" ? form.payment_method : null,
        paid_date: form.payment_status === "paid" ? form.paid_date : null,
        due_date: form.payment_status === "unpaid" ? (form.due_date || null) : null,
        note: form.note.trim() || null
      };
      const url = form.id ? `/api/accounta/expenses/${form.id}` : "/api/accounta/expenses";
      let res: Response;
      try { res = await submitJson(url, form.id ? "PATCH" : "POST", body); }
      catch (e) { setErr(submitErrMsg(e) ?? "บันทึกไม่สำเร็จ"); return; }
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "บันทึกไม่สำเร็จ")); return; }
      const expenseId = form.id ?? j.id;

      await rememberVendorIfNeeded();

      // Attach the receipt image (staged file or OCR scan) if present.
      if (stagedFile && expenseId) {
        const fd = new FormData();
        fd.append("image", stagedFile);
        await fetch(apiUrl(`/api/accounta/expenses/${expenseId}/doc`), { method: "POST", body: fd }).catch(() => {});
      }

      // Promote a draft into the ledger after its edits are saved. On failure
      // we keep the modal open so the admin can fix it (edits are persisted).
      if (opts?.confirm && expenseId) {
        const cr = await fetch(apiUrl(`/api/accounta/expenses/${expenseId}/confirm`), { method: "POST" });
        const cj = await cr.json().catch(() => ({}));
        if (!cr.ok || !cj.ok) { setErr(humanizeApiError(cj, "ยืนยันเข้าสมุดไม่สำเร็จ")); return; }
      }

      setModalOpen(false);
      await reload();
      startTransition(() => router.refresh());
    } finally { setBusy(false); }
  }

  async function remove(e: Expense) {
    const ok = await confirm({ title: "ยืนยันการลบ", body: `ลบรายจ่าย "${e.vendor_name ?? e.description ?? "รายการนี้"}" ฿${fmtMoney(e.amount_total)} ? กู้คืนไม่ได้`, confirmLabel: "ลบ", cancelLabel: "ยกเลิก", variant: "danger" });
    if (ok === null) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/accounta/expenses/${e.id}`), { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "ลบไม่สำเร็จ")); return; }
      await reload();
    } finally { setBusy(false); }
  }

  // ── Extra attachments (#3.3) ──
  async function loadExtraDocs(expenseId: number) {
    try {
      const res = await fetch(apiUrl(`/api/accounta/expenses/${expenseId}/docs`));
      const j = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(j.docs)) setExtraDocs(j.docs);
    } catch { /* ignore */ }
  }
  async function addExtraDoc(file: File) {
    if (form.id == null) return;
    setExtraBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(apiUrl(`/api/accounta/expenses/${form.id}/docs`), { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "แนบไฟล์ไม่สำเร็จ")); return; }
      await loadExtraDocs(form.id);
    } finally { setExtraBusy(false); }
  }
  async function removeExtraDoc(docId: number) {
    if (form.id == null) return;
    const ok = await confirm({ title: "ลบไฟล์แนบนี้?", confirmLabel: "ลบ", cancelLabel: "ยกเลิก", variant: "danger" });
    if (ok === null) return;
    setExtraBusy(true);
    try {
      await fetch(apiUrl(`/api/accounta/expenses/${form.id}/docs/${docId}`), { method: "DELETE" });
      await loadExtraDocs(form.id);
    } finally { setExtraBusy(false); }
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

  function downloadTemplate() {
    const header = "branch,company,bill_date,vendor,category,description,amount,has_tax_invoice,payment_status,payment_method,note";
    const sample = [
      'NAMA PASTA SRIRACHA,,2026-01-05,ร้านตัวอย่างวัตถุดิบ,สินค้า/เวชภัณฑ์,วัตถุดิบประจำสัปดาห์,1070,1,paid,โอนเงิน,ตัวอย่าง',
      ',,2026-01-06,ร้านตัวอย่างอุปกรณ์,อุปกรณ์/ของใช้สำนักงาน,,500,0,unpaid,,เครดิตเทอม รอชำระ'
    ];
    const blob = new Blob(["﻿" + [header, ...sample].join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ACCOUNTA_expense_template.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // Step 1: dry-run the file → show a preview the owner confirms before commit.
  async function previewCsv(file: File) {
    setPreviewBusy(true); setErr(null); setImportMsg(null); setPreview(null);
    try {
      const fd = new FormData();
      fd.append("csv", file);
      fd.append("dry_run", "1");
      const res = await fetch(apiUrl("/api/accounta/expenses/import"), { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "อ่านไฟล์ไม่สำเร็จ")); return; }
      setPreview(j as ImportPreview);
      setPreviewFile(file);
    } finally { setPreviewBusy(false); }
  }

  // Step 2: commit the previewed file for real.
  async function confirmImport() {
    if (!previewFile) return;
    setBusy(true); setErr(null); setImportMsg("กำลังนำเข้า…");
    try {
      const fd = new FormData();
      fd.append("csv", previewFile);
      const res = await fetch(apiUrl("/api/accounta/expenses/import"), { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setImportMsg(null); setErr(humanizeApiError(j, "นำเข้าไม่สำเร็จ")); return; }
      setImportMsg(`นำเข้าสำเร็จ ${j.imported} รายการ${j.failed ? ` · ข้าม ${j.failed} (ผิดรูปแบบ)` : ""}`);
      setPreview(null); setPreviewFile(null);
      await reload();
      startTransition(() => router.refresh());
    } finally { setBusy(false); }
  }

  const filtered = statusFilter ? expenses.filter((e) => e.payment_status === statusFilter) : expenses;

  return (
    <div className="space-y-4">
      {ConfirmDialog}
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/admin/accounta/daybook" className="btn-primary">
          + เพิ่มที่บัญชีรายวัน
        </Link>
        <button type="button" onClick={openAdd} disabled={busy} className="btn-secondary disabled:opacity-50">
          + เพิ่มด่วนที่นี่
        </button>
        <input type="month" className="input !w-auto" value={month}
          onChange={(e) => { setMonth(e.target.value); reload({ month: e.target.value }); }} />
        {activeBranch && (
          <span className="text-sm text-slate-500 px-2 py-1.5 rounded-md bg-slate-50 border border-slate-200">
            สาขา: <b className="text-slate-700">{activeBranch.name}</b>
          </span>
        )}
        <select className="input !w-auto" value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as "" | PaymentStatus)}>
          <option value="">ทุกสถานะ</option>
          <option value="paid">ชำระแล้ว</option>
          <option value="unpaid">ค้างชำระ</option>
        </select>
        <span className="ml-auto flex items-center gap-2">
          <button type="button" onClick={downloadTemplate} className="text-xs text-slate-500 hover:text-brand underline">
            เทมเพลต CSV
          </button>
          <button type="button" onClick={() => importRef.current?.click()} disabled={busy || previewBusy}
            className="btn-secondary !py-1.5 disabled:opacity-50">
            {previewBusy ? "กำลังอ่านไฟล์…" : "นำเข้า CSV"}
          </button>
          <input ref={importRef} type="file" accept=".csv,text/csv" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) previewCsv(f); e.target.value = ""; }} />
        </span>
      </div>
      {importMsg && <p className="text-sm text-emerald-700">{importMsg}</p>}

      {preview && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) { setPreview(null); setPreviewFile(null); } }}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl my-8 p-5 space-y-4">
            <div>
              <h3 className="text-lg font-bold text-slate-800">ตรวจสอบก่อนนำเข้า</h3>
              <p className="text-xs text-slate-500 mt-0.5">ยังไม่บันทึกจนกว่าจะกด “ยืนยันนำเข้า” · การนำเข้าไม่มีปุ่มย้อนกลับ</p>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg bg-emerald-50 border border-emerald-100 p-3 text-center">
                <div className="text-[11px] text-slate-500">จะนำเข้า</div>
                <div className="text-xl font-bold text-emerald-700">{preview.willImport.toLocaleString("en-US")}</div>
                <div className="text-[10px] text-slate-400">รายการ</div>
              </div>
              <div className="rounded-lg bg-rose-50 border border-rose-100 p-3 text-center">
                <div className="text-[11px] text-slate-500">ยอดรวม</div>
                <div className="text-xl font-bold text-rose-700">฿{fmtMoney(preview.total)}</div>
                <div className="text-[10px] text-slate-400">{preview.dateFrom && preview.dateTo ? `${preview.dateFrom} → ${preview.dateTo}` : "—"}</div>
              </div>
              <div className={`rounded-lg border p-3 text-center ${preview.failed > 0 ? "bg-amber-50 border-amber-200" : "bg-slate-50 border-slate-100"}`}>
                <div className="text-[11px] text-slate-500">ข้าม (ผิดรูปแบบ)</div>
                <div className={`text-xl font-bold ${preview.failed > 0 ? "text-amber-700" : "text-slate-400"}`}>{preview.failed.toLocaleString("en-US")}</div>
                <div className="text-[10px] text-slate-400">รายการ</div>
              </div>
            </div>

            {preview.unresolvedBranch > 0 && (
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                ⚠ {preview.unresolvedBranch} รายการระบุสาขาที่จับคู่ไม่ได้ — จะลงเป็นยังไม่ผูกสาขา
              </p>
            )}

            <div>
              <div className="text-xs font-bold text-slate-600 mb-1">แยกตามหมวด</div>
              <div className="border border-slate-100 rounded-lg divide-y divide-slate-50 max-h-40 overflow-y-auto">
                {preview.byCategory.map((c) => (
                  <div key={c.name} className="flex items-center justify-between px-3 py-1.5 text-sm">
                    <span className="text-slate-700">{c.name} <span className="text-slate-400 text-[11px]">×{c.count}</span></span>
                    <span className="font-mono text-rose-700">฿{fmtMoney(c.amount)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="text-xs font-bold text-slate-600 mb-1">ตัวอย่าง {preview.sample.length} แถวแรก</div>
              <div className="border border-slate-100 rounded-lg divide-y divide-slate-50 max-h-44 overflow-y-auto text-[12px]">
                {preview.sample.map((s, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 px-3 py-1.5">
                    <span className="text-slate-400 shrink-0 w-20">{s.bill_date}</span>
                    <span className="text-slate-700 truncate flex-1">{s.vendor || "—"}</span>
                    <span className="text-slate-400 shrink-0 text-[11px]">{s.category || "—"}</span>
                    <span className="font-mono text-rose-700 shrink-0">฿{fmtMoney(s.amount)}</span>
                  </div>
                ))}
              </div>
            </div>

            {preview.errors.length > 0 && (
              <div>
                <div className="text-xs font-bold text-amber-700 mb-1">แถวที่ข้าม (ตัวอย่าง)</div>
                <div className="border border-amber-100 rounded-lg divide-y divide-amber-50 max-h-28 overflow-y-auto text-[11px]">
                  {preview.errors.slice(0, 10).map((e, i) => (
                    <div key={i} className="px-3 py-1 text-amber-700">แถว {e.row}: {e.message}</div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button type="button" onClick={() => { setPreview(null); setPreviewFile(null); }} disabled={busy}
                className="btn-secondary disabled:opacity-50">ยกเลิก</button>
              <button type="button" onClick={confirmImport} disabled={busy || preview.willImport === 0}
                className="btn-primary disabled:opacity-50">
                {busy ? "กำลังนำเข้า…" : `ยืนยันนำเข้า ${preview.willImport.toLocaleString("en-US")} รายการ`}
              </button>
            </div>
          </div>
        </div>
      )}

      {err && <p className="text-sm text-rose-600">{err}</p>}

      {/* Draft inbox — bills staff sent to the LINE OA, awaiting review.
          Global (not month/branch-scoped). Don't count in the totals until
          confirmed. (owner 2026-06-18) */}
      {drafts.length > 0 && (
        <div className="card border-amber-300 bg-amber-50/60 space-y-2 p-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-amber-900">📥 ร่างรอตรวจ (จากไลน์)</span>
            <span className="text-xs bg-amber-500 text-white font-bold rounded-full px-2 py-0.5">{drafts.length}</span>
          </div>
          <p className="text-[11px] text-amber-800/80">
            เอกสารที่พนักงานส่งเข้าไลน์ — กด “ตรวจ” เพื่อผูกสาขา แก้ไข แล้วยืนยันเข้าสมุด (ยังไม่นับในยอดจนกว่าจะยืนยัน)
          </p>
          <ul className="divide-y divide-amber-200">
            {drafts.map((d) => (
              <li key={d.id} className="flex items-center gap-3 py-2">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-slate-800 truncate">{d.vendor_name || "— ยังไม่ระบุร้าน —"}</div>
                  <div className="text-[11px] text-slate-500 truncate">
                    {formatLongDate(d.bill_date, "th")} · {docTypeLabel(d.doc_type) ? `${docTypeLabel(d.doc_type)} · ` : ""}{d.category || "ไม่ระบุหมวด"}{d.note ? ` · ${d.note}` : ""}
                  </div>
                </div>
                {d.has_doc && (
                  <a href={apiUrl(`/api/accounta/expenses/${d.id}/doc`)} target="_blank" rel="noreferrer"
                    className="text-[11px] text-brand hover:underline whitespace-nowrap">ดูเอกสาร</a>
                )}
                <div className="text-right font-semibold text-slate-800 whitespace-nowrap">
                  {d.amount_total > 0 ? `฿${fmtMoney(d.amount_total)}` : "—"}
                </div>
                <button type="button" onClick={() => openEdit(d)} disabled={busy}
                  className="btn-secondary !py-1 !px-3 text-xs disabled:opacity-50">ตรวจ</button>
                <button type="button" onClick={() => remove(d)} disabled={busy}
                  className="!py-1 !px-2 text-xs text-red-500 hover:text-red-700 hover:underline disabled:opacity-50"
                  title="ลบร่างที่ส่งผิด/ส่งเกิน (ไม่ต้องยืนยันก่อน)">ลบ</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Summary — accrual vs cash flow + outstanding */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="card space-y-1">
          <div className="text-[11px] tracking-wide text-slate-400">ตามเอกสาร (เดือนนี้)</div>
          <div className="text-2xl font-bold text-slate-800">฿{fmtMoney(summary.accrual.total)}</div>
          <div className="text-xs text-slate-500">
            ฐาน ฿{fmtMoney(summary.accrual.base)} · ภาษีซื้อ <span className="text-brand font-semibold">฿{fmtMoney(summary.inputVat)}</span> · {summary.accrual.count} เอกสาร
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
          <div className="text-xs text-slate-500">{summary.unpaidCount} เอกสารรอชำระ</div>
        </div>
      </div>

      {props.ocrAvailable && (
        <p className="text-[11px] text-slate-400">
          OCR สแกนเอกสาร: เดือนนี้ {usage.monthCount} ครั้ง ~฿{fmtMoney(usage.monthBaht)} · รวมทั้งหมด {usage.totalCount} ครั้ง ~฿{fmtMoney(usage.totalBaht)} (ประมาณการ)
        </p>
      )}

      {/* Category vs benchmark % — actual spend / revenue vs the F&B target
          band (owner 2026-06-18). Collapsed by default. */}
      {budget.items.length > 0 && (
        <details className="card">
          <summary className="cursor-pointer text-sm font-bold text-slate-700 select-none">
            เทียบเป้า % ค่าใช้จ่าย (เทียบรายรับเดือนนี้)
            <span className="font-normal text-slate-500">
              {budget.revenue > 0 ? ` · รายรับ ฿${fmtMoney(budget.revenue)}` : " · ยังไม่มีรายรับเดือนนี้ (กรอกที่หน้ารายรับ)"}
            </span>
          </summary>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-400 text-left border-b border-slate-100">
                  <th className="py-1.5 px-2 font-semibold">หมวด</th>
                  <th className="py-1.5 px-2 text-right font-semibold">ใช้จริง</th>
                  <th className="py-1.5 px-2 text-right font-semibold">% รายรับ</th>
                  <th className="py-1.5 px-2 text-right font-semibold">เป้า %</th>
                  <th className="py-1.5 px-2 text-center font-semibold">สถานะ</th>
                </tr>
              </thead>
              <tbody>
                {budget.items.map((it) => (
                  <tr key={it.name} className="border-b border-slate-50">
                    <td className="py-1.5 px-2">
                      {it.code && <span className="font-bold text-slate-700">{it.code}</span>} {it.name}
                      {it.description && <div className="text-[10px] text-slate-400">{it.description}</div>}
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono whitespace-nowrap">฿{fmtMoney(it.spent)}</td>
                    <td className="py-1.5 px-2 text-right font-mono">{it.pct != null ? `${it.pct}%` : "—"}</td>
                    <td className="py-1.5 px-2 text-right text-slate-500 whitespace-nowrap">
                      {it.targetMin != null ? `${it.targetMin}–${it.targetMax}%` : "—"}
                    </td>
                    <td className="py-1.5 px-2 text-center">
                      {it.status === "over" ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 font-bold">เกินเป้า</span>
                        : it.status === "under" ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-100 text-sky-700">ต่ำกว่าเป้า</span>
                        : it.status === "ok" ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">อยู่ในเป้า</span>
                        : <span className="text-slate-300">—</span>}
                    </td>
                  </tr>
                ))}
                {budget.uncategorized > 0 && (
                  <tr className="border-b border-slate-50 text-slate-400">
                    <td className="py-1.5 px-2 italic">(ไม่ระบุหมวด / หมวดอื่น)</td>
                    <td className="py-1.5 px-2 text-right font-mono">฿{fmtMoney(budget.uncategorized)}</td>
                    <td colSpan={3} />
                  </tr>
                )}
              </tbody>
            </table>
            <p className="text-[10px] text-slate-400 mt-2">
              % เทียบกับรายรับเดือนนี้ · เป้า % อ้างอิงทฤษฎีร้านอาหาร (แก้ได้ที่ผังหมวด) · นับเฉพาะรายการที่ยืนยันแล้ว
            </p>
          </div>
        </details>
      )}

      {/* List */}
      {filtered.length === 0 ? (
        <div className="card text-center py-10 text-slate-500">
          ยังไม่มีรายจ่ายในเดือนนี้ — กด “เพิ่มรายจ่าย” เพื่อเริ่มลงเอกสาร
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-slate-400 border-b border-slate-100">
                <th className="px-3 py-2">สาขา</th>
                <th className="px-3 py-2">ผู้จำหน่าย / รายการ</th>
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
              {groupExpenses(filtered).map((mo) => (
                <Fragment key={mo.month}>
                  <tr className="bg-slate-100/70 border-y border-slate-200">
                    <td colSpan={9} className="px-3 py-1.5">
                      <div className="flex items-baseline justify-between">
                        <span className="text-xs font-bold text-slate-700">{monthLabel(mo.month)}</span>
                        <span className="text-xs font-bold text-rose-700">฿{fmtMoney(mo.total)}</span>
                      </div>
                    </td>
                  </tr>
                  {mo.days.map((d) => (
                    <Fragment key={d.date}>
                      <tr className="bg-slate-50 border-b border-slate-100">
                        <td colSpan={9} className="px-3 py-1">
                          <div className="flex items-baseline justify-between">
                            <span className="text-[11px] font-semibold text-slate-500">{formatLongDate(d.date, "th")}</span>
                            <span className="text-[11px] font-mono font-bold text-rose-700">฿{fmtMoney(d.total)}</span>
                          </div>
                        </td>
                      </tr>
                      {d.rows.map((e) => (
                <tr key={e.id} className="border-b border-slate-50 hover:bg-slate-50/60">
                  <td className="px-3 py-2 whitespace-nowrap text-slate-600">
                    {e.branch_name ? <div className="text-[10px] text-slate-400">{e.branch_name}</div> : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-800 flex items-center gap-1.5 flex-wrap">
                      {e.vendor_name || "—"}
                      {e.capex_bucket && <span className="text-[10px] font-normal bg-violet-50 text-violet-700 border border-violet-200 rounded-full px-1.5 py-px" title="ผูกกับ FEASIBILITY (เงินลงทุนตั้งต้น)">FEASIBILITY · {STARTUP_CATEGORY_LABEL[e.capex_bucket as keyof typeof STARTUP_CATEGORY_LABEL] ?? "ลงทุน"}</span>}
                      {!!e.awaiting_doc && <span className="text-[10px] font-normal bg-amber-100 text-amber-800 border border-amber-300 rounded-full px-1.5 py-px" title="ยังไม่ได้รับใบเสร็จ/ใบกำกับภาษี">⏳ รอเอกสาร</span>}
                      {!!e.is_fixed && <span className="text-[10px] font-normal bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-full px-1.5 py-px" title="นับเป็นต้นทุนคงที่ในจุดคุ้มทุน">คงที่</span>}
                    </div>
                    {docTypeLabel(e.doc_type) && (
                      <span className="inline-block text-[10px] bg-slate-100 text-slate-500 rounded px-1.5 py-0.5 mt-0.5">{docTypeLabel(e.doc_type)}</span>
                    )}
                    {e.description && <div className="text-[11px] text-slate-500">{e.description}</div>}
                    <div className="flex gap-2">
                      {e.has_doc && (
                        <a href={apiUrl(`/api/accounta/expenses/${e.id}/doc`)} target="_blank" rel="noreferrer"
                          className="text-[11px] text-brand hover:underline">ดูเอกสาร</a>
                      )}
                      <a href={`/admin/accounta/expenses/${e.id}/substitute-receipt`} target="_blank" rel="noreferrer"
                        className="text-[11px] text-slate-500 hover:underline" title="ออกใบรับรองแทนใบเสร็จ (เมื่อไม่มีใบเสร็จ/ใบกำกับ)">ใบแทน</a>
                    </div>
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
                      className="text-xs text-slate-500 hover:text-brand">แก้ไข</button>
                    <button type="button" onClick={() => remove(e)} disabled={busy}
                      className="text-xs text-slate-400 hover:text-rose-600 ml-3">ลบออก</button>
                  </td>
                </tr>
                      ))}
                    </Fragment>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add / edit modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setModalOpen(false); }}>
          <div className={`card w-full ${showDoc ? "max-w-6xl" : "max-w-2xl"} my-8`} onClick={(ev) => ev.stopPropagation()}>
            <div className="flex flex-col lg:flex-row gap-4 items-start">
            {showDoc && form.id != null && (
              <div className="w-full lg:w-[46%] shrink-0 lg:sticky lg:top-2 self-start order-first lg:order-last">
                <iframe src={apiUrl(`/api/accounta/expenses/${form.id}/doc`)} title="เอกสาร"
                  className="w-full h-[45vh] lg:h-[80vh] rounded-lg border border-slate-200 bg-slate-50" />
              </div>
            )}
            <div className="flex-1 min-w-0 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-bold text-slate-800">
                {draftMode ? "ตรวจร่างจากไลน์" : form.id ? "แก้ไขรายจ่าย" : "เพิ่มรายจ่าย"}
              </h3>
              <div className="flex items-center gap-2">
                {form.id != null && editingHasDoc && (
                  <button type="button" onClick={() => setShowDoc((v) => !v)}
                    className="rounded-md border border-brand/40 text-brand px-3 py-1 text-sm font-medium hover:bg-brand/5 whitespace-nowrap">
                    {showDoc ? "ซ่อนเอกสาร" : "ดูเอกสาร"}
                  </button>
                )}
                <button type="button" onClick={() => setModalOpen(false)} className="text-slate-400 hover:text-slate-700">✕</button>
              </div>
            </div>

            {props.ocrAvailable && !form.id && (
              <div className="rounded-lg border border-dashed border-brand/40 bg-brand/5 p-3 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <button type="button" disabled={scanning}
                    onClick={() => ocrInputRef.current?.click()}
                    className="btn-secondary !py-1.5 disabled:opacity-50">
                    {scanning ? "กำลังอ่าน…" : "ถ่ายรูป / อัปโหลดเอกสาร แล้วกรอกให้อัตโนมัติ"}
                  </button>
                  <span className="text-[11px] text-slate-500">ตรวจทานตัวเลขทุกครั้งก่อนบันทึก</span>
                </div>
                {scanMsg && <p className="text-[11px] text-emerald-700">{scanMsg}</p>}
                {/* No `capture` attr → the OS picker offers BOTH camera and
                    album (owner 2026-06-17: was camera-only). */}
                <input ref={ocrInputRef} type="file" accept="image/*,application/pdf" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) runOcr(f); e.target.value = ""; }} />
              </div>
            )}

            {/* Mixed-bill split — OCR found both VAT-able and VAT-exempt items
                (owner 2026-06-18). One tap files two rows so input VAT is
                claimed only on the VAT-able part. */}
            {mixedSplit && !form.id && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-2">
                <div className="text-xs font-bold text-amber-900">เอกสารผสม VAT / ไม่มี VAT</div>
                <div className="text-[11px] text-amber-800">
                  มี VAT ฿{fmtMoney(mixedSplit.vatable)} (ภาษีซื้อ ฿{fmtMoney(mixedSplit.vat)}) · ไม่มี VAT ฿{fmtMoney(mixedSplit.nonvat)}
                </div>
                <p className="text-[11px] text-amber-800/80">
                  แยกเป็น 2 รายการให้คิดภาษีซื้อเฉพาะส่วนที่มี VAT — ใช้สาขา/บริษัท/ผู้จำหน่าย/หมวด ตามที่กรอกด้านล่าง (แก้หมวดของแต่ละแถวได้ภายหลัง)
                </p>
                <button type="button" onClick={splitSave} disabled={busy}
                  className="btn-primary !py-1.5 text-xs disabled:opacity-50">
                  {busy ? "กำลังบันทึก…" : "แยกเป็น 2 รายการ"}
                </button>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Branch-locked to the active branch (owner 2026-07-03) — no
                  cross-branch picker; switch branch via the top pill. */}
              <div className="sm:col-span-2">
                <label className="label !text-xs">บริษัท · สาขา</label>
                <div className="input !bg-slate-50 !text-slate-600 flex items-center">
                  <span>{activeCompanyName ? `${activeCompanyName} · ` : ""}{activeBranch?.name ?? "— เลือกสาขาที่มุมบนซ้าย —"}</span>
                </div>
              </div>
              <div>
                <label className="label !text-xs">วันที่เอกสาร</label>
                <input type="date" className="input" value={form.bill_date} onChange={(e) => setBillDate(e.target.value)} />
              </div>
              <div>
                <label className="label !text-xs">ประเภทเอกสาร</label>
                <select className="input" value={form.doc_type}
                  onChange={(e) => {
                    const v = e.target.value;
                    // เลือก "ใบกำกับภาษีเต็มรูป" → ติ๊กแยก VAT 7% ให้เลย (เอกสารเดียวที่เคลมภาษีซื้อได้)
                    setForm((f) => ({ ...f, doc_type: v, has_tax_invoice: v === "tax_invoice" ? true : f.has_tax_invoice }));
                  }}>
                  <option value="">— เลือก —</option>
                  {DOC_TYPES.map((t) => <option key={t} value={t}>{DOC_TYPE_LABEL[t]}</option>)}
                </select>
              </div>
              <div>
                <label className="label !text-xs">หมวดหมู่</label>
                {newCat === null ? (
                  <select className="input" value={form.category}
                    onChange={(e) => { if (e.target.value === "__add__") setNewCat(""); else set("category", e.target.value); }}>
                    <option value="">— เลือก —</option>
                    {categories.map((c) => <option key={c.id} value={c.name}>{c.code ? `${c.code} · ${c.name}` : c.name}</option>)}
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
              {categories.find((c) => c.name === form.category)?.code === CAPEX_CATEGORY_CODE && (
                <div className="sm:col-span-2">
                  <label className="label !text-xs">หมวดลงทุน (สำหรับ FEASIBILITY)</label>
                  <select className="input" value={form.capex_bucket} onChange={(e) => set("capex_bucket", e.target.value)}>
                    <option value="">— ไม่ระบุ (ไม่ดึงเข้าโปรเจค) —</option>
                    {STARTUP_CATEGORIES.map((b) => <option key={b} value={b}>{STARTUP_CATEGORY_LABEL[b]}</option>)}
                  </select>
                  <p className="text-[11px] text-slate-400 mt-1">
                    เลือกหมวดย่อย แล้วบิลนี้จะถูกดึงเข้า &ldquo;เงินลงทุนตั้งต้น&rdquo; ของโปรเจค FEASIBILITY ที่เชื่อมสาขานี้อัตโนมัติ
                  </p>
                </div>
              )}
              <div className="sm:col-span-2">
                <label className="label !text-xs">ผู้จำหน่าย / ผู้รับเงิน</label>
                <Combobox value={form.vendor_name} onChange={(v) => set("vendor_name", v)}
                  options={vendors.map((v) => v.name)} placeholder="พิมพ์ชื่อ หรือเลือกจากรายการ" />
              </div>
              <div>
                <label className="label !text-xs">เลขที่ใบกำกับ/บิล</label>
                <input className="input font-mono" value={form.invoice_no} onChange={(e) => set("invoice_no", e.target.value)} placeholder="เลขที่บนบิล (ใช้เช็คบิลซ้ำ)" />
              </div>
              <div>
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
                    placeholder="แก้ไขจำนวน" title="กรอกถ้าต้องการกำหนดภาษีมูลค่าเพิ่มเอง (เว้นว่าง = คำนวณ 7%)" />
                )}
              </div>
            )}

            {/* Withholding tax (หัก ณ ที่จ่าย) — computed on the ex-VAT base */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
              <div>
                <label className="label !text-xs">หัก ณ ที่จ่าย</label>
                <select className="input" value={form.wht_rate} onChange={(e) => set("wht_rate", e.target.value)}>
                  <option value="0">ไม่หัก</option>
                  <option value="0.01">1% (ค่าขนส่ง)</option>
                  <option value="0.03">3% (ค่าบริการ/รับจ้าง)</option>
                  <option value="0.05">5% (ค่าเช่า)</option>
                </select>
              </div>
              {Number(form.wht_rate) > 0 && Number(form.amount_total) > 0 && (
                <div className="text-xs text-slate-500 pb-2">
                  หัก ณ ที่จ่าย <span className="text-rose-600 font-semibold">฿{fmtMoney(round2(vatPreview.base * (Number(form.wht_rate) || 0)))}</span> ·
                  จ่ายจริง <span className="text-slate-800 font-semibold">฿{fmtMoney(round2((Number(form.amount_total) || 0) - round2(vatPreview.base * (Number(form.wht_rate) || 0))))}</span>
                </div>
              )}
            </div>

            {/* Compact toggle buttons (owner 2026-07-21: ปุ่มสวยๆ ชัดๆ) —
                จ่าย/ลงบัญชีก่อนยังไม่ได้เอกสาร + คงที่/แปรผัน (จุดคุ้มทุน). */}
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => set("awaiting_doc", !form.awaiting_doc)}
                title="จ่าย/ลงบัญชีก่อน — ค่อยตามใบเสร็จ/ใบกำกับภาษีทีหลัง"
                className={`px-3.5 py-2 rounded-full text-sm font-medium border transition ${
                  form.awaiting_doc ? "bg-amber-100 border-amber-400 text-amber-800" : "bg-white border-slate-300 text-slate-500 hover:bg-slate-50"}`}>
                {form.awaiting_doc ? "✓ " : ""}ยังไม่ได้รับเอกสาร
              </button>
              <button type="button" onClick={() => set("is_fixed", !form.is_fixed)}
                title="นับเข้าจุดคุ้มทุนแบบต้นทุนคงที่ (ไม่เลือก = รายจ่ายแปรผัน)"
                className={`px-3.5 py-2 rounded-full text-sm font-medium border transition ${
                  form.is_fixed ? "bg-indigo-100 border-indigo-400 text-indigo-800" : "bg-white border-slate-300 text-slate-500 hover:bg-slate-50"}`}>
                {form.is_fixed ? "✓ " : ""}ต้นทุนคงที่/รายจ่ายประจำ
              </button>
            </div>

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
                        {props.expenseChannels.length > 0 && (
                          <optgroup label="ช่องทางที่ตั้งค่าไว้">
                            {props.expenseChannels.map((c) => <option key={`ch:${c}`} value={c}>{c}</option>)}
                          </optgroup>
                        )}
                        <optgroup label="อื่น ๆ">
                          {methods.map((m) => <option key={m.id} value={m.name}>{m.name}</option>)}
                          <option value="__add__">+ เพิ่มช่องทาง…</option>
                        </optgroup>
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
              {form.payment_status === "unpaid" && (
                <div className="sm:col-span-2">
                  <label className="label !text-xs">วันที่ครบกำหนดชำระ (เครดิตเทอม)</label>
                  <input type="date" className="input sm:w-1/2" value={form.due_date} onChange={(e) => set("due_date", e.target.value)} />
                </div>
              )}
            </div>
            {form.payment_status === "paid" && form.payment_method.includes("เครดิต") && (
              <p className="text-[11px] text-slate-400 -mt-1">
                บัตรเครดิต: ลงเอกสารตามวันที่เอกสาร แต่ “วันที่เงินออกจริง” คือรอบตัดบัตร (อาจเป็นเดือนถัดไป) — แยกในมุมมองกระแสเงินสด
              </p>
            )}

            <div>
              <label className="label !text-xs">หมายเหตุ</label>
              <input className="input" value={form.note} onChange={(e) => set("note", e.target.value)} />
            </div>

            {/* หลักฐานเพิ่มเติม — เฉพาะเอกสารที่บันทึกแล้ว (owner 2026-06-20, #3.3) */}
            {form.id != null && (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-2.5 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-600">หลักฐานเพิ่มเติม (สลิปโอน / ใบอื่นๆ)</span>
                  <button type="button" onClick={() => extraRef.current?.click()} disabled={extraBusy}
                    className="text-xs text-brand hover:underline disabled:opacity-50">
                    {extraBusy ? "กำลังอัป…" : "+ แนบไฟล์"}
                  </button>
                  <input ref={extraRef} type="file" accept="image/*,application/pdf" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) addExtraDoc(f); e.target.value = ""; }} />
                </div>
                {extraDocs.length === 0 ? (
                  <p className="text-[11px] text-slate-400">ยังไม่มีไฟล์แนบเพิ่ม</p>
                ) : (
                  <ul className="space-y-1">
                    {extraDocs.map((d) => (
                      <li key={d.id} className="flex items-center gap-2 text-[11px]">
                        <a href={apiUrl(`/api/accounta/expenses/${form.id}/docs/${d.id}`)} target="_blank" rel="noreferrer"
                          className="text-brand hover:underline flex-1 truncate">
                          {d.label || (d.doc_mime === "application/pdf" ? "ไฟล์ PDF" : "รูปภาพ")}
                        </a>
                        <button type="button" onClick={() => removeExtraDoc(d.id)} disabled={extraBusy}
                          className="text-red-500 hover:underline disabled:opacity-50">ลบ</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-3 text-xs text-slate-500">
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={form.rememberVendor} onChange={(e) => set("rememberVendor", e.target.checked)} />
                  บันทึกผู้จำหน่ายนี้
                </label>
                <button type="button" onClick={() => fileRef.current?.click()} className="hover:text-brand">
                  {stagedFile ? `แนบเอกสาร: ${stagedFile.name.slice(0, 20)}` : "แนบรูปเอกสาร"}
                </button>
                <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden"
                  onChange={(e) => setStagedFile(e.target.files?.[0] ?? null)} />
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setModalOpen(false)} className="btn-secondary" disabled={busy}>ยกเลิก</button>
                {draftMode ? (
                  <>
                    <button type="button" onClick={() => save()} className="btn-secondary disabled:opacity-50" disabled={busy}>
                      {busy ? "กำลังบันทึก…" : "บันทึกร่าง"}
                    </button>
                    <button type="button" onClick={() => save({ confirm: true })} className="btn-primary disabled:opacity-50" disabled={busy}>
                      {busy ? "กำลังบันทึก…" : "ยืนยันเข้าสมุด"}
                    </button>
                  </>
                ) : (
                  <button type="button" onClick={() => save()} className="btn-primary disabled:opacity-50" disabled={busy}>
                    {busy ? "กำลังบันทึก…" : "บันทึก"}
                  </button>
                )}
              </div>
            </div>
            </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
