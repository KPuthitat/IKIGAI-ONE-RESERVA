import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { listCCCharges, createCCCharge, creditCardReserve, type CCChargeInput } from "@/lib/accounta-db";

function bkkMonth(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);
}

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

export async function GET(req: Request) {
  requirePermission("accounta.manage");
  const b = new URL(req.url).searchParams.get("branch");
  const branchId = b && Number.isInteger(Number(b)) ? Number(b) : null;
  if (branchId == null) return NextResponse.json({ error: "branch_required" }, { status: 400 });
  return NextResponse.json({ ok: true, reserve: creditCardReserve(branchId, bkkMonth()), charges: listCCCharges(branchId) });
}

export async function POST(req: Request) {
  const user = requirePermission("accounta.manage");
  const parsed = CCBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const id = createCCCharge(user.id, toCCInput(parsed.data));
  return NextResponse.json({ ok: true, id });
}
