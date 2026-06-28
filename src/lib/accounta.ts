// ── ACCOUNTA — pure shared helpers (client + server safe) ──────────
//
// NO better-sqlite3 / db import here. Client components ("use client")
// import the constants + VAT/cost maths from this file; the server-only
// data layer lives in accounta-db.ts and the OCR caller in accounta-ocr.ts.
// (Same client/server boundary rule that bit FEASIBILITY — see CLAUDE.md.)

// ── Expense taxonomy ───────────────────────────────────────────────
//
// Expense categories and payment methods are OWNER-EXTENSIBLE picklists
// stored in the DB (accounta_categories / accounta_payment_methods),
// seeded from the owner's Excel chart. Expenses store the chosen NAME as
// free text. The lists below are only fallbacks for callers that have no
// DB list to hand.

export type PaymentStatus = "paid" | "unpaid";

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  paid: "ชำระแล้ว",
  unpaid: "ค้างชำระ"
};

// ── Document type (ประเภทเอกสาร) ───────────────────────────────────
// Classifies the source document a bill came from. Descriptive only — the
// VAT-claim driver is still `has_tax_invoice` (a full tax invoice is the
// only doc you can claim ภาษีซื้อ on). The form pre-checks has_tax_invoice
// when the owner picks "ใบกำกับภาษี (เต็มรูป)". (owner 2026-06-20.)
export type DocType =
  | "receipt" | "tax_invoice" | "tax_invoice_abbr"
  | "cash_bill" | "transfer_slip" | "invoice" | "other";

export const DOC_TYPE_LABEL: Record<DocType, string> = {
  receipt: "ใบเสร็จรับเงิน",
  tax_invoice: "ใบกำกับภาษี (เต็มรูป)",
  tax_invoice_abbr: "ใบกำกับภาษีอย่างย่อ",
  cash_bill: "บิลเงินสด",
  transfer_slip: "สลิปโอนเงิน",
  invoice: "ใบแจ้งหนี้",
  other: "อื่นๆ"
};

export const DOC_TYPES = Object.keys(DOC_TYPE_LABEL) as DocType[];

export function isDocType(v: unknown): v is DocType {
  return typeof v === "string" && (DOC_TYPES as string[]).includes(v);
}

export function docTypeLabel(v: string | null | undefined): string | null {
  return v && isDocType(v) ? DOC_TYPE_LABEL[v] : null;
}

// ── VAT (ภาษีซื้อ) ─────────────────────────────────────────────────

export const VAT_RATE = 0.07;

export function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Split a VAT-INCLUSIVE total into base + 7% input VAT. When the bill
 *  carries no full tax invoice the whole amount is base and VAT is 0 (you
 *  can't claim ภาษีซื้อ without ใบกำกับภาษีเต็มรูป). Owner choice
 *  2026-06-16: enter the grand total, let the system derive VAT. */
export function splitVat(total: number, hasTaxInvoice: boolean): { base: number; vat: number } {
  const t = Number(total) || 0;
  if (!hasTaxInvoice || t <= 0) return { base: round2(t), vat: 0 };
  const vat = round2((t * VAT_RATE) / (1 + VAT_RATE));
  return { base: round2(t - vat), vat };
}

// ── OCR model + cost estimate ──────────────────────────────────────
//
// Prices are LIST PRICE ESTIMATES (USD per million tokens) as of the
// model knowledge cutoff — treat the baht figures as ประมาณการ, not a
// billing source of truth. Adjust here if Anthropic pricing changes.

export const THB_PER_USD = 36; // rough; only used for the on-screen estimate

export type OcrModel = {
  id: string;
  label: string;
  inUsdPerMtok: number;
  outUsdPerMtok: number;
};

export const OCR_MODELS: OcrModel[] = [
  {
    id: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5 — ประหยัด (พอสำหรับบิลพิมพ์)",
    inUsdPerMtok: 1,
    outUsdPerMtok: 5
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6 — แม่นกว่า (บิลเขียนมือ/อ่านยาก)",
    inUsdPerMtok: 3,
    outUsdPerMtok: 15
  }
];

export const DEFAULT_OCR_MODEL = "claude-haiku-4-5-20251001";

export function ocrModel(id: string | null | undefined): OcrModel {
  return OCR_MODELS.find((m) => m.id === id) ?? OCR_MODELS[0];
}

/** Estimated baht cost of one OCR call given token counts. */
export function ocrCostBaht(modelId: string | null | undefined, inTok: number, outTok: number): number {
  const m = ocrModel(modelId);
  const usd = (inTok / 1e6) * m.inUsdPerMtok + (outTok / 1e6) * m.outUsdPerMtok;
  return round2(usd * THB_PER_USD);
}

// ── Shared types ───────────────────────────────────────────────────

export type ExpenseInput = {
  branch_id: number | null;
  company_id: number | null;
  bill_date: string;            // YYYY-MM-DD (accrual)
  vendor_id: number | null;
  vendor_name: string | null;
  doc_type: DocType | null;     // ประเภทเอกสาร (descriptive)
  category: string | null;      // category NAME (free text, from the picklist)
  description: string | null;
  amount_total: number;
  has_tax_invoice: boolean;
  vat_amount: number;           // may be overridden; defaults to splitVat()
  base_amount: number;
  payment_status: PaymentStatus;
  payment_method: string | null; // method NAME (free text, from the picklist)
  paid_date: string | null;     // cash-flow date; required-ish when paid
  due_date: string | null;      // วันที่ครบกำหนดชำระ — for credit-term unpaid bills
  note: string | null;
  // When this bill is CapEx (category === CAPEX_CATEGORY_NAME), the FEASIBILITY
  // investment bucket it belongs to (a StartupCategory key) — feeds the project
  // editor's "เงินลงทุนตั้งต้น" live. Optional/null for non-CapEx / unassigned.
  capex_bucket?: string | null;
};

// The investment category — bills tagged this (code "CP") may carry a
// capex_bucket and flow into FEASIBILITY's initial-investment section.
export const CAPEX_CATEGORY_CODE = "CP";
export const CAPEX_CATEGORY_NAME = "รายจ่ายลงทุน/ครุภัณฑ์ (CapEx)";

/** What an OCR scan returns to pre-fill the add form. All fields optional —
 *  the model fills what it can read; the human confirms before saving. */
export type OcrBillResult = {
  vendor_name: string | null;
  tax_id: string | null;
  bill_date: string | null;     // YYYY-MM-DD if parseable
  amount_total: number | null;
  has_tax_invoice: boolean | null;
  vat_amount: number | null;
  doc_type: string | null;      // one of DOC_TYPES, or null
  category: string | null;
  description: string | null;
  // Mixed-bill split (owner 2026-06-18): when a single bill carries both
  // VAT-able and VAT-exempt line items, these hold the two VAT-inclusive
  // subtotals so the system can break it into two entries. Either may be
  // null/0 when the whole bill is one kind.
  vatable_amount: number | null;  // sum of items that carry VAT (incl. VAT)
  nonvat_amount: number | null;   // sum of items with no VAT
};

/** A mixed bill split into its two VAT-inclusive subtotals, with the input
 *  VAT computed on the VAT-able portion only. Returns null when the bill
 *  isn't genuinely mixed (one side missing/zero, or the parts don't add up
 *  to roughly the total). Pure — shared by the in-app form + LINE ingest. */
export function splitMixedBill(r: OcrBillResult): { vatable: number; vat: number; nonvat: number } | null {
  const vatable = round2(Number(r.vatable_amount) || 0);
  const nonvat = round2(Number(r.nonvat_amount) || 0);
  if (vatable <= 0 || nonvat <= 0) return null;       // not actually mixed
  const total = round2(Number(r.amount_total) || 0);
  // Sanity: the two parts should sum to ~the total (allow ฿1 rounding slack).
  if (total > 0 && Math.abs(round2(vatable + nonvat) - total) > 1) return null;
  // VAT-able side: prefer the printed VAT if it's plausibly for that portion,
  // else extract 7% from the VAT-inclusive subtotal.
  const vat = splitVat(vatable, true).vat;
  return { vatable, vat, nonvat };
}
