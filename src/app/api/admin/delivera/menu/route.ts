import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { createMenuItem } from "@/lib/delivera/orders";

// Admin (session): create a DELIVERA menu item for the active branch.
export const dynamic = "force-dynamic";

const Body = z.object({
  name_th: z.string().trim().min(1).max(120),
  category: z.string().trim().max(60).nullable().optional(),
  description: z.string().trim().max(300).nullable().optional(),
  price: z.number().min(0).max(1e6),
  is_available: z.boolean().optional(),
  sort_order: z.number().int().optional(),
  is_standard_meal: z.boolean().optional(),
  credit_cost: z.number().int().min(0).max(100000).optional()
});

export async function POST(req: Request) {
  const user = requirePermission("delivera.manage");
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const id = createMenuItem(user.activeBranchId, parsed.data);
  return NextResponse.json({ ok: true, id });
}
