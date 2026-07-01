import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { listRecurring, createRecurring, type RecurringInput } from "@/lib/accounta-db";

// Recurring expense templates (owner 2026-06-30) — monthly auto-post.
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

export async function GET(req: Request) {
  requirePermission("accounta.manage");
  const b = new URL(req.url).searchParams.get("branch");
  const branchId = b && Number.isInteger(Number(b)) ? Number(b) : null;
  return NextResponse.json({ ok: true, recurring: listRecurring(branchId) });
}

export async function POST(req: Request) {
  const user = requirePermission("accounta.manage");
  const parsed = RecurringBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const id = createRecurring(user.id, toRecurringInput(parsed.data));
  return NextResponse.json({ ok: true, id });
}
