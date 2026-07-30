import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCan } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { redeemDrinkOrder, DRINK_TIERS } from "@/lib/partner-drink-orders";

// POST /api/staff/persona/drink-redeem
//
// The จ้อจี้ partner account picks the price tier (50/80) then scans a staff
// member's drink-order QR to fulfil it. Gated on the partner.drink.redeem
// permission (strict — NOT the legacy admin fallback). Redeeming LOCKS the
// payroll deduction on the staff member at the chosen tier.

const Body = z.object({
  token: z.string().min(8).max(128),
  amount: z.number().refine((n) => (DRINK_TIERS as readonly number[]).includes(n), "bad_amount"),
  payment_method: z.enum(["payroll", "cash"])
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCan(user, "partner.drink.redeem")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const branchIds = user.branches.map((b) => b.id);
  const result = redeemDrinkOrder(parsed.data.token, user.id, branchIds, parsed.data.amount, parsed.data.payment_method);
  if (!result.ok) {
    const status = result.error === "not_found" ? 404
      : result.error === "already" ? 409
      : result.error === "expired" ? 410
      : (result.error === "bad_amount" || result.error === "bad_method") ? 400
      : 403; // wrong_partner
    return NextResponse.json({ error: result.error }, { status });
  }

  logPersonaAction(user.id, `drink_redeem.${result.paymentMethod}.${result.amount}`, null);

  return NextResponse.json({
    ok: true,
    amount: result.amount,
    staffName: result.staffName,
    orderDate: result.orderDate,
    paymentMethod: result.paymentMethod
  });
}
