import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { confirmMealOrder, cancelMealOrder, redeemDrinkCoupon, MealpassError } from "@/lib/mealpass";
import { nowBkkMinutes } from "@/lib/time";

// POST /api/admin/persona/mealpass/confirm — a manager confirms (or cancels) a
// staffer's pending meal order by its MP-xxxx code. After the branch cutoff a
// confirm needs { override: true, overrideReason } — the reason is logged.
//   body: { code, action?: 'confirm'|'cancel', override?, overrideReason? }

const Body = z.object({
  code: z.string().min(3).max(32),
  action: z.enum(["confirm", "cancel"]).default("confirm"),
  override: z.boolean().optional(),
  overrideReason: z.string().max(500).optional(),
});

function statusFor(code: string): number {
  if (code === "not_found") return 404;
  if (code === "already_confirmed" || code === "not_pending") return 409;
  return 400;
}

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  // Managers confirm meals; in this system admins/super-admins carry that duty.
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const { code, action, override, overrideReason } = parsed.data;

  try {
    // Free in-store drink coupon (DR-xxxx) — a different table, always a plain
    // confirm (no cutoff/override, no credits).
    if (code.toUpperCase().startsWith("DR")) {
      const r = redeemDrinkCoupon({ code, confirmerUserId: user.id });
      logPersonaAction(user.id, "mealpass.drink.redeem");
      return NextResponse.json(r);
    }
    if (action === "cancel") {
      cancelMealOrder(code);
      logPersonaAction(user.id, "mealpass.order.cancel");
      return NextResponse.json({ ok: true, action: "cancelled" });
    }
    const nowHhmm = (() => {
      const { minutes } = nowBkkMinutes();
      return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    })();
    const result = confirmMealOrder({
      code, confirmerUserId: user.id, nowHhmm, override, overrideReason,
    });
    logPersonaAction(user.id, "mealpass.order.confirm");
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof MealpassError) return NextResponse.json({ error: e.code }, { status: statusFor(e.code) });
    throw e;
  }
}
