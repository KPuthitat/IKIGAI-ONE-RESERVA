// ── ACCOUNTA — pure shared helpers (client + server safe) ──────────
//
// NO better-sqlite3 / db import here. Client components ("use client")
// import the constants + VAT/cost maths from this file; the server-only
// data layer lives in accounta-db.ts and the OCR caller in accounta-ocr.ts.
// (Same client/server boundary rule that bit FEASIBILITY — see CLAUDE.md.)

// ── Expense taxonomy ───────────────────────────────────────────────

/** Default expense categories (clinic + general business). The owner can
 *  pick "อื่นๆ" and type a free description; this list is just the quick
 *  picker, not an enforced enum. */
export const EXPENSE_CATEGORIES = [
  "วัตถุดิบ/เวชภัณฑ์",
  "ค่าเช่า",
  "เงินเดือน/ค่าแรง",
  "สาธารณูปโภค (น้ำ/ไฟ/เน็ต)",
  "การตลาด/โฆษณา",
  "ซอฟต์แวร์/ระบบ",
  "ค่าขนส่ง/เดินทาง",
  "อุปกรณ์/ของใช้สำนักงาน",
  "ค่าธรรมเนียม/บริการวิชาชีพ",
  "ประกัน",
  "ซ่อมบำรุง",
  "อื่นๆ"
] as const;

export type PaymentStatus = "paid" | "unpaid";
export type PaymentMethod = "cash" | "transfer" | "credit_card" | "director" | "other";

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  paid: "ชำระแล้ว",
  unpaid: "ค้างชำระ"
};

export const PAYMENT_METHODS: Array<{ value: PaymentMethod; label: string }> = [
  { value: "cash", label: "เงินสด" },
  { value: "transfer", label: "โอนเงิน" },
  { value: "credit_card", label: "บัตรเครดิต" },
  { value: "director", label: "กรรมการสำรองจ่าย" },
  { value: "other", label: "อื่นๆ" }
];

export function paymentMethodLabel(m: string | null | undefined): string {
  return PAYMENT_METHODS.find((x) => x.value === m)?.label ?? "—";
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
  category: string | null;
  description: string | null;
  amount_total: number;
  has_tax_invoice: boolean;
  vat_amount: number;           // may be overridden; defaults to splitVat()
  base_amount: number;
  payment_status: PaymentStatus;
  payment_method: PaymentMethod | null;
  paid_date: string | null;     // cash-flow date; required-ish when paid
  note: string | null;
};

/** What an OCR scan returns to pre-fill the add form. All fields optional —
 *  the model fills what it can read; the human confirms before saving. */
export type OcrBillResult = {
  vendor_name: string | null;
  tax_id: string | null;
  bill_date: string | null;     // YYYY-MM-DD if parseable
  amount_total: number | null;
  has_tax_invoice: boolean | null;
  vat_amount: number | null;
  category: string | null;
  description: string | null;
};
