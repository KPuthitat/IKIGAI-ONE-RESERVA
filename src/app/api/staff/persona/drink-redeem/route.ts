import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCan } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { redeemDrinkOrder } from "@/lib/partner-drink-orders";

// POST /api/staff/persona/drink-redeem
//
// The จ้อจี้ partner account scans a staff member's drink-order QR to fulfil it.
// Gated on the partner.drink.redeem permission (strict — NOT the legacy
// admin fallback). Redeeming LOCKS the payroll deduction on the staff member.

const Body = z.object({ token: z.string().min(8).max(128) });

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCan(user, "partner.drink.redeem")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const branchIds = user.branches.map((b) => b.id);
  const result = redeemDrinkOrder(parsed.data.token, user.id, branchIds);
  if (!result.ok) {
    const status = result.error === "not_found" ? 404
      : result.error === "already" ? 409
      : result.error === "expired" ? 410
      : 403; // wrong_partner
    return NextResponse.json({ error: result.error }, { status });
  }

  logPersonaAction(user.id, `drink_redeem.${result.amount}`, null);

  return NextResponse.json({
    ok: true,
    amount: result.amount,
    staffName: result.staffName,
    orderDate: result.orderDate
  });
}
