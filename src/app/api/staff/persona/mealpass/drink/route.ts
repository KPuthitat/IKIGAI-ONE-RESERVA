import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { chooseDrinkForCoupon, MealpassError } from "@/lib/mealpass";
import { todayBkk } from "@/lib/time";

// POST /api/staff/persona/mealpass/drink — staff picks a canned in-store drink
// for today's free drink coupon → returns the code/QR to show the manager.
const Body = z.object({ menuItemId: z.number().int().positive() });

function statusFor(code: string): number {
  if (code === "no_coupon") return 404;
  if (code === "already_used") return 409;
  return 400;
}

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  try {
    const r = chooseDrinkForCoupon({ userId: user.id, dateBkk: todayBkk(), menuItemId: parsed.data.menuItemId });
    logPersonaAction(user.id, "mealpass.drink.choose", parsed.data.menuItemId);
    return NextResponse.json({ ok: true, code: r.code });
  } catch (e) {
    if (e instanceof MealpassError) return NextResponse.json({ error: e.code }, { status: statusFor(e.code) });
    throw e;
  }
}
