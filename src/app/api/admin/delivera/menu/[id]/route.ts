import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { updateMenuItem, deleteMenuItem } from "@/lib/delivera/orders";

// Admin (session): edit / delete a DELIVERA menu item (branch-scoped in the lib).
export const dynamic = "force-dynamic";

const Body = z.object({
  name_th: z.string().trim().min(1).max(120).optional(),
  category: z.string().trim().max(60).nullable().optional(),
  description: z.string().trim().max(300).nullable().optional(),
  price: z.number().min(0).max(1e6).optional(),
  is_available: z.boolean().optional(),
  sort_order: z.number().int().optional(),
  is_standard_meal: z.boolean().optional(),
  credit_cost: z.number().int().min(0).max(100000).optional()
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = requirePermission("delivera.manage");
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const id = Number(params.id);
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const ok = updateMenuItem(id, user.activeBranchId, parsed.data);
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "not_found" }, { status: 404 });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = requirePermission("delivera.manage");
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const ok = deleteMenuItem(Number(params.id), user.activeBranchId);
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "not_found" }, { status: 404 });
}
