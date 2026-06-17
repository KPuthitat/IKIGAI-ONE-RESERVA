// Shared zod schema + ExpenseInput builder for the ACCOUNTA expense API
// (POST create + PATCH update). Server-only (imported by route handlers).

import { z } from "zod";
import { splitVat, round2, type ExpenseInput } from "./accounta";

export const ExpenseBody = z.object({
  branch_id: z.number().int().positive().nullable().optional(),
  company_id: z.number().int().positive().nullable().optional(),
  bill_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  vendor_id: z.number().int().positive().nullable().optional(),
  vendor_name: z.string().trim().max(200).nullable().optional(),
  category: z.string().trim().max(100).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  amount_total: z.number().min(0).max(1e9),
  has_tax_invoice: z.boolean().optional(),
  vat_amount: z.number().min(0).max(1e9).nullable().optional(),
  payment_status: z.enum(["paid", "unpaid"]).optional(),
  payment_method: z.string().trim().max(60).nullable().optional(),
  paid_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
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
    category: d.category ?? null,
    description: d.description ?? null,
    amount_total: total,
    has_tax_invoice: hasTax,
    vat_amount: vat,
    base_amount: base,
    payment_status: d.payment_status ?? "paid",
    payment_method: d.payment_method ?? null,
    paid_date: d.paid_date ?? null,
    note: d.note ?? null
  };
}
