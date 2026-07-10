import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { updateZone, deleteZone } from "@/lib/delivera/db";

// Admin (session): edit / delete a delivery zone (branch-scoped in the lib).
export const dynamic = "force-dynamic";

const Body = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  max_distance_km: z.number().min(0).max(100).optional(),
  base_fee: z.number().min(0).max(1e5).optional(),
  per_km_fee: z.number().min(0).max(1e5).optional(),
  min_order_amount: z.number().min(0).max(1e6).optional(),
  is_active: z.boolean().optional()
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = requirePermission("delivera.manage");
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const ok = updateZone(Number(params.id), user.activeBranchId, parsed.data);
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "not_found" }, { status: 404 });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = requirePermission("delivera.manage");
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const ok = deleteZone(Number(params.id), user.activeBranchId);
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "not_found" }, { status: 404 });
}
