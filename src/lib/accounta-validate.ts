// Shared zod schema + ExpenseInput builder for the ACCOUNTA expense API
// (POST create + PATCH update). Server-only (imported by route handlers).

import { z } from "zod";
import { splitVat, round2, DOC_TYPES, type DocType, type ExpenseInput } from "./accounta";
import { STARTUP_CATEGORIES } from "./feasibility";
import type { CCChargeInput, RecurringInput } from "./accounta-db";

// Director credit-card charge schema. Lives here (not in the route file)
// because Next.js route modules may ONLY export HTTP handlers + route
// config — exporting a helper/schema from a route/[id] pair fails the
// `next build` route-type check even though `tsc --noEmit` accepts it.
export const CCBody = z.object({
  branch_id: z.number().int().positive().nullable().optional(),
  card_id: z.number().int().positive().nullable().optional(),
  card_name: z.string().trim().max(120).nullable().optional(),
  merchant: z.string().trim().max(200).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  purchase_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  total_amount: z.number().min(0).max(1e9),
  installments: z.number().int().min(1).max(60),
  first_due_month: z.string().regex(/^\d{4}-\d{2}$/),
  note: z.string().trim().max(500).nullable().optional()
});

export function toCCInput(d: z.infer<typeof CCBody>): CCChargeInput {
  return {
    branch_id: d.branch_id ?? null, card_id: d.card_id ?? null, card_name: d.card_name ?? null,
    merchant: d.merchant ?? null, description: d.description ?? null, purchase_date: d.purchase_date,
    total_amount: d.total_amount, installments: d.installments, first_due_month: d.first_due_month, note: d.note ?? null
  };
}

// Recurring expense templates (owner 2026-06-30) — moved here for the same
// Next.js route-export reason as CCBody above.
export const RecurringBody = z.object({
  branch_id: z.number().int().positive().nullable().optional(),
  company_id: z.number().int().positive().nullable().optional(),
  vendor_name: z.string().trim().max(200).nullable().optional(),
  category: z.string().trim().max(100).nullable().optional(),
  capex_bucket: z.string().trim().max(40).nullable().optional(),
  doc_type: z.string().trim().max(40).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  amount_total: z.number().min(0).max(1e9),
  has_tax_invoice: z.boolean().optional(),
  vat_amount: z.number().min(0).max(1e9).nullable().optional(),
  wht_rate: z.number().min(0).max(0.05).nullable().optional(),
  payment_status: z.enum(["paid", "unpaid"]),
  payment_method: z.string().trim().max(200).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  day_of_month: z.number().int().min(1).max(31),
  start_month: z.string().regex(/^\d{4}-\d{2}$/),
  end_month: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional(),
  active: z.boolean().optional(),
  is_fixed: z.boolean().optional()   // default fixed (owner 2026-07-21) — set in toRecurringInput
});

export function toRecurringInput(d: z.infer<typeof RecurringBody>): RecurringInput {
  return {
    branch_id: d.branch_id ?? null, company_id: d.company_id ?? null,
    vendor_name: d.vendor_name ?? null, category: d.category ?? null, capex_bucket: d.capex_bucket ?? null,
    doc_type: d.doc_type ?? null, description: d.description ?? null,
    amount_total: d.amount_total, has_tax_invoice: !!d.has_tax_invoice, vat_amount: d.vat_amount ?? 0,
    wht_rate: d.wht_rate ?? 0,
    payment_status: d.payment_status, payment_method: d.payment_method ?? null, note: d.note ?? null,
    day_of_month: d.day_of_month, start_month: d.start_month, end_month: d.end_month ?? null,
    active: d.active ?? true,
    // Default fixed when the client omits it (recurring = คงที่ by default).
    is_fixed: d.is_fixed ?? true
  };
}

export const ExpenseBody = z.object({
  branch_id: z.number().int().positive().nullable().optional(),
  company_id: z.number().int().positive().nullable().optional(),
  bill_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  vendor_id: z.number().int().positive().nullable().optional(),
  vendor_name: z.string().trim().max(200).nullable().optional(),
  invoice_no: z.string().trim().max(60).nullable().optional(),  // เลขที่ใบกำกับ/บิล (duplicate key)
  // Coerce an unknown/legacy doc_type (e.g. a Thai label on an imported row) to
  // null instead of 400-rejecting the whole save — a bad doc_type must never make
  // an otherwise-valid bill uneditable (owner 2026-06-28).
  doc_type: z.preprocess(
    (v) => (typeof v === "string" && (DOC_TYPES as readonly string[]).includes(v) ? v : null),
    z.enum(DOC_TYPES as [DocType, ...DocType[]]).nullable()
  ).optional(),
  category: z.string().trim().max(100).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  amount_total: z.number().min(0).max(1e9),
  has_tax_invoice: z.boolean().optional(),
  vat_amount: z.number().min(0).max(1e9).nullable().optional(),
  // Withholding tax rate ∈ {0,.01,.03,.05}; amount derived server-side (owner 2026-07-05)
  wht_rate: z.number().min(0).max(0.05).nullable().optional(),
  // FEASIBILITY investment bucket for a CapEx bill — coerce an unknown value to
  // null (don't reject the save). accounta-db drops it when category ≠ CapEx.
  capex_bucket: z.preprocess(
    (v) => (typeof v === "string" && (STARTUP_CATEGORIES as readonly string[]).includes(v) ? v : null),
    z.string().nullable()
  ).optional(),
  awaiting_doc: z.boolean().optional(),   // จ่ายแล้วแต่ยังไม่ได้รับเอกสาร (owner 2026-07-06)
  is_fixed: z.boolean().optional(),       // ต้นทุนคงที่ (break-even) — default variable (owner 2026-07-21)
  payment_status: z.enum(["paid", "unpaid"]).optional(),
  payment_method: z.string().trim().max(200).nullable().optional(),  // channel master bank-account names can be long
  paid_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  due_mode: z.enum(["on_receipt", "cycle", "date"]).nullable().optional(),  // credit-term scheduling (owner 2026-07-21)
  note: z.string().trim().max(500).nullable().optional()
});

export type ExpenseBodyT = z.infer<typeof ExpenseBody>;

// ── Purchase credit note (ใบลดหนี้ฝั่งซื้อ) — owner 2026-08-23 ─────────
// A supplier credit note reduces a purchase: less expense + less input VAT
// (ภาษีซื้อ). Stored as a SEPARATE accounta_expenses row with NEGATIVE
// amount_total / vat_amount / base_amount and doc_type='credit_note', so it
// flows through every existing SUM (expense, ภพ.30, category, daybook) with
// no aggregation changes. The client enters POSITIVE reduction amounts; the
// sign is applied here.
export const CreditNoteBody = z.object({
  branch_id: z.number().int().positive().nullable().optional(),
  company_id: z.number().int().positive().nullable().optional(),
  credit_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),     // วันที่ในใบลดหนี้
  vendor_id: z.number().int().positive().nullable().optional(),
  vendor_name: z.string().trim().max(200).nullable().optional(),
  credit_no: z.string().trim().max(60).nullable().optional(),      // เลขที่ใบลดหนี้
  ref_invoice_no: z.string().trim().max(120).nullable().optional(), // อ้างอิงบิล/ใบกำกับเดิม
  category: z.string().trim().max(100).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),   // เหตุผล (คืนของ/ลดราคา)
  amount_total: z.number().positive().max(1e9),                    // ยอดที่ลด (รวม VAT)
  has_tax_invoice: z.boolean().optional(),                        // true = ลดภาษีซื้อได้ (ใบลดหนี้เต็มรูป)
  vat_amount: z.number().min(0).max(1e9).nullable().optional(),    // override; else 7% split
  note: z.string().trim().max(500).nullable().optional()
}).refine(
  // A VAT override can never exceed the reduction total, else the ex-VAT base
  // would flip positive (over-crediting ภาษีซื้อ while raising base expense).
  (d) => d.vat_amount == null || d.vat_amount <= d.amount_total,
  { message: "ภาษีซื้อที่ลดต้องไม่เกินยอดที่ลด", path: ["vat_amount"] }
);

export type CreditNoteBodyT = z.infer<typeof CreditNoteBody>;

/** Build a negative-amount ExpenseInput representing a purchase credit note. */
export function toCreditNoteInput(d: CreditNoteBodyT): ExpenseInput {
  const total = round2(d.amount_total);
  const hasTax = !!d.has_tax_invoice;
  let vat: number, base: number;
  if (d.vat_amount != null) { vat = round2(d.vat_amount); base = round2(total - vat); }
  else { const s = splitVat(total, hasTax); vat = s.vat; base = s.base; }
  // Fold the original-invoice reference into the note so it stays visible.
  const refNote = [d.ref_invoice_no ? `อ้างอิงบิล ${d.ref_invoice_no}` : null, d.note?.trim() || null]
    .filter(Boolean).join(" · ") || null;
  return {
    branch_id: d.branch_id ?? null,
    company_id: d.company_id ?? null,
    bill_date: d.credit_date,
    vendor_id: d.vendor_id ?? null,
    vendor_name: d.vendor_name ?? null,
    invoice_no: d.credit_no?.trim() || null,
    doc_type: "credit_note",
    category: d.category ?? null,
    capex_bucket: null,
    description: d.description ?? null,
    // Negate so the row reduces expense + input VAT in every aggregation.
    amount_total: round2(-total),
    has_tax_invoice: hasTax,
    vat_amount: round2(-vat),
    base_amount: round2(-base),
    wht_rate: 0,
    awaiting_doc: false,
    is_fixed: false,
    // A credit note is a settlement (not a payable) — mark paid so it never
    // shows up in ค้างชำระ; the accrual (expense/VAT) reduction is date-based.
    payment_status: "paid",
    payment_method: null,
    paid_date: d.credit_date,
    due_date: null,
    due_mode: null,
    note: refNote
  };
}

/** Build a normalised ExpenseInput from a validated body. Honours an
 *  explicit vat_amount override; otherwise derives the 7% split. */
export function toExpenseInput(d: ExpenseBodyT): ExpenseInput {
  const total = round2(d.amount_total);
  const hasTax = !!d.has_tax_invoice;
  let vat: number, base: number;
  if (d.vat_amount != null) { vat = round2(d.vat_amount); base = round2(total - vat); }
  else { const s = splitVat(total, hasTax); vat = s.vat; base = s.base; }
  return {
    branch_id: d.branch_id ?? null,
    company_id: d.company_id ?? null,
    bill_date: d.bill_date,
    vendor_id: d.vendor_id ?? null,
    vendor_name: d.vendor_name ?? null,
    invoice_no: d.invoice_no ?? null,
    doc_type: d.doc_type ?? null,
    category: d.category ?? null,
    capex_bucket: d.capex_bucket ?? null,
    description: d.description ?? null,
    amount_total: total,
    has_tax_invoice: hasTax,
    vat_amount: vat,
    base_amount: base,
    wht_rate: d.wht_rate ?? 0,
    awaiting_doc: !!d.awaiting_doc,
    is_fixed: !!d.is_fixed,
    payment_status: d.payment_status ?? "paid",
    payment_method: d.payment_method ?? null,
    paid_date: d.paid_date ?? null,
    due_date: d.due_date ?? null,
    due_mode: d.due_mode ?? null,
    note: d.note ?? null
  };
}
