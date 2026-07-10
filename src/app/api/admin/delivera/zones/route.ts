import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { createZone } from "@/lib/delivera/db";

// Admin (session): create a delivery zone for the active branch.
export const dynamic = "force-dynamic";

const Body = z.object({
  name: z.string().trim().min(1).max(60),
  max_distance_km: z.number().min(0).max(100),
  base_fee: z.number().min(0).max(1e5),
  per_km_fee: z.number().min(0).max(1e5),
  min_order_amount: z.number().min(0).max(1e6)
});

export async function POST(req: Request) {
  const user = requirePermission("delivera.manage");
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const id = createZone(user.activeBranchId, parsed.data);
  return NextResponse.json({ ok: true, id });
}
