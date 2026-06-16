import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import {
  createItem, STARTUP_CATEGORIES
} from "@/lib/feasibility-startup-db";

// POST /api/feasibility/[id]/startup-items — add a startup-spend line item.
// Owner-scoped (the lib verifies the project belongs to the caller).

const Body = z.object({
  category: z.enum(STARTUP_CATEGORIES),
  paid_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  item_name: z.string().trim().min(1).max(200),
  payee: z.string().trim().max(200).nullable().optional(),
  amount: z.number().min(0),
  wht_mode: z.enum(["none", "baht", "pct"]).optional(),
  wht_value: z.number().min(0).optional(),
  doc_type: z.enum(["tax_invoice", "receipt"]).nullable().optional(),
  payment_status: z.enum(["paid", "pending"]).optional(),
  doc_image_path: z.string().max(400).nullable().optional()
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = requirePermission("accounta.manage");
  const projectId = Number(params.id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  const newId = createItem(projectId, user.id, {
    category: d.category,
    paid_date: d.paid_date ?? null,
    item_name: d.item_name,
    payee: d.payee ?? null,
    amount: d.amount,
    wht_mode: d.wht_mode ?? "none",
    wht_value: d.wht_value ?? 0,
    doc_type: d.doc_type ?? null,
    payment_status: d.payment_status ?? "paid",
    doc_image_path: d.doc_image_path ?? null
  });
  if (newId == null) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, id: newId });
}
