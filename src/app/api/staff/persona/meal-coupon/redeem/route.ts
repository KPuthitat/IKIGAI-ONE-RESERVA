import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction, type Branch } from "@/lib/db";
import { redeemCoupon } from "@/lib/meal-coupons";
import { mealCouponRedeemedFlex, notifyToStaffGroup } from "@/lib/line";
import { bkkHHMM } from "@/lib/time";
import { nameWithPrefix } from "@/lib/name";

// POST /api/staff/persona/meal-coupon/redeem
//
// A staff member redeems a lunch/drink coupon by picking a menu item from the
// branch they're currently at. Idempotent (re-post on a redeemed coupon → 409
// already_redeemed). On success we push a Flex card to the staff/kitchen group
// so the kitchen sees who wants which menu (owner 2026-07-12, "2A").

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

  // Notify the staff/kitchen group — fire-and-forget, never blocks the redeem.
  try {
    const branch = getDb().prepare("SELECT * FROM branches WHERE id = ?")
      .get(result.branchId) as Branch | undefined;
    if (branch) {
      const flex = mealCouponRedeemedFlex({
        branchName: branch.name,
        staffName: nameWithPrefix(user.title_prefix, user.display_name),
        type: result.type,
        menuName: result.menuName,
        timeStr: bkkHHMM(new Date().toISOString()),
        headerColor: branch.brand_color
      });
      void notifyToStaffGroup(branch, flex, "global").catch(() => { /* swallow */ });
    }
  } catch (e) {
    console.error("meal coupon notify failed", e);
  }

  return NextResponse.json({ ok: true, type: result.type, menuName: result.menuName });
}
