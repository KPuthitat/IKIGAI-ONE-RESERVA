import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { redeemCoupon } from "@/lib/meal-coupons";

// POST /api/staff/persona/meal-coupon/redeem
//
// A staff member redeems a lunch/drink coupon by picking a menu item from the
// branch they're currently at. Idempotent (re-post on a redeemed coupon → 409
// already_redeemed). No per-redeem LINE notification — the executives get one
// combined summary at ~15:00 via the cron (owner 2026-07-12).

const Body = z.object({
  couponId: z.number().int().positive(),
  menuItemId: z.number().int().positive()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.activeBranchId == null) {
    return NextResponse.json({ error: "no_branch" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { couponId, menuItemId } = parsed.data;

  const result = redeemCoupon(user.id, couponId, user.activeBranchId, menuItemId);
  if (!result.ok) {
    const status = result.error === "not_found" ? 404
      : result.error === "already_redeemed" ? 409
      : result.error === "expired" ? 410
      : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  logPersonaAction(user.id, `meal_coupon.redeem.${result.type}`, couponId);

  return NextResponse.json({ ok: true, type: result.type, menuName: result.menuName });
}
