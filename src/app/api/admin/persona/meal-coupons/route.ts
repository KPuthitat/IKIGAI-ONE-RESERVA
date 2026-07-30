import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import {
  updateMealCouponConfig, addCouponMenu, setCouponMenuActive, removeCouponMenu, setCouponMenuCredit
} from "@/lib/meal-coupons";

// /api/admin/persona/meal-coupons — admin config for the staff meal-coupon
// feature (owner 2026-07-12). Per-branch: the admin's activeBranchId picks the
// branch, overridable via body.branch_id (must be one they're assigned to).
// One POST with an `action` discriminator keeps the route small.

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("config"),
    branch_id: z.number().int().positive().optional(),
    enabled: z.boolean().optional(),
    eligible_starts: z.array(z.string().regex(TIME_RE)).max(12).optional(),
    redeem_cutoff: z.string().regex(TIME_RE).optional(),
    late_grace_min: z.number().int().min(0).max(240).optional()
  }),
  z.object({
    action: z.literal("add_menu"),
    branch_id: z.number().int().positive().optional(),
    menu_item_id: z.number().int().positive(),
    type: z.enum(["food", "drink"])
  }),
  z.object({
    action: z.literal("toggle_menu"),
    branch_id: z.number().int().positive().optional(),
    id: z.number().int().positive(),
    active: z.boolean()
  }),
  z.object({
    action: z.literal("remove_menu"),
    branch_id: z.number().int().positive().optional(),
    id: z.number().int().positive()
  }),
  z.object({
    action: z.literal("set_credit"),
    branch_id: z.number().int().positive().optional(),
    id: z.number().int().positive(),
    // null clears; a positive value tags the food item's welfare credit (60/120)
    credit_value: z.number().int().positive().max(100000).nullable()
  })
]);

function resolveBranchId(
  user: NonNullable<ReturnType<typeof getSessionUser>>,
  override: number | undefined
): { ok: true; branchId: number } | { ok: false; status: number; error: string } {
  const id = override ?? user.activeBranchId;
  if (!id) return { ok: false, status: 400, error: "no_active_branch" };
  if (!userHasBranch(user, id)) return { ok: false, status: 403, error: "branch_forbidden" };
  return { ok: true, branchId: id };
}

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;
  const r = resolveBranchId(user, data.branch_id);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  const branchId = r.branchId;

  switch (data.action) {
    case "config":
      updateMealCouponConfig(branchId, {
        enabled: data.enabled,
        eligibleStarts: data.eligible_starts,
        redeemCutoff: data.redeem_cutoff,
        graceMin: data.late_grace_min
      });
      break;
    case "add_menu":
      addCouponMenu(branchId, data.menu_item_id, data.type);
      break;
    case "toggle_menu":
      setCouponMenuActive(data.id, branchId, data.active);
      break;
    case "remove_menu":
      removeCouponMenu(data.id, branchId);
      break;
    case "set_credit":
      setCouponMenuCredit(data.id, branchId, data.credit_value);
      break;
  }
  logPersonaAction(user.id, `meal_coupon.admin.${data.action}`, branchId);
  return NextResponse.json({ ok: true });
}
