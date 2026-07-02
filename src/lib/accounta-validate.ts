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
  payment_status: z.enum(["paid", "unpaid"]),
  payment_method: z.string().trim().max(200).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  day_of_month: z.number().int().min(1).max(31),
  start_month: z.string().regex(/^\d{4}-\d{2}$/),
  end_month: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional(),
  active: z.boolean().optional()
});

export function toRecurringInput(d: z.infer<typeof RecurringBody>): RecurringInput {
  return {
    branch_id: d.branch_id ?? null, company_id: d.company_id ?? null,
    vendor_name: d.vendor_name ?? null, category: d.category ?? null, capex_bucket: d.capex_bucket ?? null,
    doc_type: d.doc_type ?? null, description: d.description ?? null,
    amount_total: d.amount_total, has_tax_invoice: !!d.has_tax_invoice, vat_amount: d.vat_amount ?? 0,
    payment_status: d.payment_status, payment_method: d.payment_method ?? null, note: d.note ?? null,
    day_of_month: d.day_of_month, start_month: d.start_month, end_month: d.end_month ?? null,
    active: d.active ?? true
  };
}

export const ExpenseBody = z.object({
  branch_id: z.number().int().positive().nullable().optional(),
  company_id: z.number().int().positive().nullable().optional(),
  bill_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  vendor_id: z.number().int().positive().nullable().optional(),
  vendor_name: z.string().trim().max(200).nullable().optional(),
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
  // FEASIBILITY investment bucket for a CapEx bill — coerce an unknown value to
  // null (don't reject the save). accounta-db drops it when category ≠ CapEx.
  capex_bucket: z.preprocess(
    (v) => (typeof v === "string" && (STARTUP_CATEGORIES as readonly string[]).includes(v) ? v : null),
    z.string().nullable()
  ).optional(),
  payment_status: z.enum(["paid", "unpaid"]).optional(),
  payment_method: z.string().trim().max(200).nullable().optional(),  // channel master bank-account names can be long
  paid_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional()
});

export type ExpenseBodyT = z.infer<typeof ExpenseBody>;

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
    doc_type: d.doc_type ?? null,
    category: d.category ?? null,
    capex_bucket: d.capex_bucket ?? null,
    description: d.description ?? null,
    amount_total: total,
    has_tax_invoice: hasTax,
    vat_amount: vat,
    base_amount: base,
    payment_status: d.payment_status ?? "paid",
    payment_method: d.payment_method ?? null,
    paid_date: d.paid_date ?? null,
    due_date: d.due_date ?? null,
    note: d.note ?? null
  };
}
