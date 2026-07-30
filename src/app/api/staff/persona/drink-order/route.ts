import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { createDrinkOrder, DRINK_TIERS } from "@/lib/partner-drink-orders";

// POST /api/staff/persona/drink-order
//
// A clocked-in staff member orders a drink-welfare drink (50/80) from the
// branch's จ้อจี้ partner. Requires today's unredeemed drink coupon. Returns a
// one-time token the client renders as a QR for จ้อจี้ to scan. Re-posting with a
// different amount replaces the prior pending order (fresh token).

const Body = z.object({
  amount: z.number().refine((n) => (DRINK_TIERS as readonly number[]).includes(n), "bad_amount")
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.activeBranchId == null) {
    return NextResponse.json({ error: "no_branch" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "bad_amount" }, { status: 400 });

  const result = createDrinkOrder(user.id, user.activeBranchId, parsed.data.amount);
  if (!result.ok) {
    const status = result.error === "no_coupon" ? 409 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  logPersonaAction(user.id, `drink_order.create.${result.amount}`, result.orderId);

  return NextResponse.json({
    ok: true,
    token: result.token,
    amount: result.amount,
    expiresAt: result.expiresAt,
    partnerName: result.partnerName
  });
}
