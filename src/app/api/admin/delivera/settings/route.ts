import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { setBranchSettings, setDeliveraEnabled } from "@/lib/delivera/db";

// Admin (session): per-branch DELIVERA settings — enable flag, PromptPay id, prep
// minutes, and the opt-in integration-hook toggles. Scoped to the active branch.
export const dynamic = "force-dynamic";

const Body = z.object({
  enabled: z.boolean().optional(),
  promptpay_id: z.string().trim().max(30).nullable().optional(),
  default_prep_minutes: z.number().int().min(1).max(240).optional(),
  hook_deduct_stock: z.boolean().optional(),
  hook_post_income: z.boolean().optional(),
  hook_record_insigna: z.boolean().optional()
});

export async function POST(req: Request) {
  const user = requirePermission("delivera.manage");
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  if (d.enabled !== undefined) setDeliveraEnabled(user.activeBranchId, d.enabled);
  setBranchSettings(user.activeBranchId, {
    promptpay_id: d.promptpay_id, default_prep_minutes: d.default_prep_minutes,
    hook_deduct_stock: d.hook_deduct_stock, hook_post_income: d.hook_post_income, hook_record_insigna: d.hook_record_insigna
  });
  return NextResponse.json({ ok: true });
}
