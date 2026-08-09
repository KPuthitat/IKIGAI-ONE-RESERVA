import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import {
  balanceForUser, createMealOrder, getMealpassConfig, ymOf, MealpassError,
} from "@/lib/mealpass";
import { todayBkk } from "@/lib/time";

// GET  /api/staff/persona/mealpass — this staffer's balance + today's meal order.
// POST /api/staff/persona/mealpass — create a pending in-house meal order.
//   body: { menuItemId, dineInAck }
// Staff-facing: never expose cost/COG wording — only credits + normal price.

export async function GET() {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.activeBranchId == null) return NextResponse.json({ error: "no_branch" }, { status: 400 });

  const db = getDb();
  const day = todayBkk();
  const cfg = getMealpassConfig(user.activeBranchId, db);
  const balance = balanceForUser(user.id, ymOf(day), db);
  const todayOrder = db.prepare(
    `SELECT code, menu_name_snap AS menuName, meal_class AS mealClass, credits, baht, status
       FROM mealpass_orders
      WHERE user_id = ? AND order_date = ? AND kind = 'meal' AND status IN ('pending','confirmed')
      ORDER BY id DESC LIMIT 1`
  ).get(user.id, day);

  return NextResponse.json({
    ok: true,
    enabled: cfg.enabled === 1,
    balance,
    redeemCutoff: cfg.redeem_cutoff,
    todayOrder: todayOrder ?? null,
  });
}

const Body = z.object({
  menuItemId: z.number().int().positive(),
  dineInAck: z.boolean(),
});

// MealpassError code → HTTP status.
function statusFor(code: string): number {
  if (code === "already_today" || code === "already_confirmed" || code === "not_pending") return 409;
  return 400;
}

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.activeBranchId == null) return NextResponse.json({ error: "no_branch" }, { status: 400 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  try {
    const result = createMealOrder({
      userId: user.id,
      branchId: user.activeBranchId,
      menuItemId: parsed.data.menuItemId,
      dineInAck: parsed.data.dineInAck,
      dateBkk: todayBkk(),
    });
    logPersonaAction(user.id, "mealpass.order.create", result.id);
    return NextResponse.json({ ok: true, order: result });
  } catch (e) {
    if (e instanceof MealpassError) return NextResponse.json({ error: e.code }, { status: statusFor(e.code) });
    throw e;
  }
}
