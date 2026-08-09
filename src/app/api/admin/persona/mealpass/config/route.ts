import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { setMealpassConfig } from "@/lib/mealpass";

// POST /api/admin/persona/mealpass/config — create/update the active branch's
// MEALPASS config (enable/disable + rates/caps/cutoff). Admin only.
const Body = z.object({
  enabled: z.boolean().optional(),
  redeem_cutoff: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  monthly_cap: z.number().int().min(0).max(100000).optional(),
  full_day_credits: z.number().int().min(0).max(10000).optional(),
  half_day_credits: z.number().int().min(0).max(10000).optional(),
  standard_credit_cost: z.number().int().min(0).max(100000).optional(),
  special_rate: z.number().min(0).max(1).optional(),
  cash_discount: z.number().min(0).max(1).optional(),
  cross_company_cap_baht: z.number().min(0).max(1e6).optional(),
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (user.activeBranchId == null) return NextResponse.json({ error: "no_branch" }, { status: 400 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });

  const { enabled, ...rest } = parsed.data;
  const cfg = setMealpassConfig(user.activeBranchId, {
    ...rest,
    ...(enabled !== undefined ? { enabled: enabled ? 1 : 0 } : {}),
  });
  logPersonaAction(user.id, "mealpass.config.update", user.activeBranchId);
  return NextResponse.json({ ok: true, config: cfg });
}
