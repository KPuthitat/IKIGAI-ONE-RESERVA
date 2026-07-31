import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { createDrinkOrder } from "@/lib/partner-drink-orders";

// POST /api/staff/persona/drink-order
//
// A staff member who has clocked in today generates a drink QR for the branch's
// จ้อจี้ partner (owner 2026-07-31: no coupon, no shift gate, unlimited — self-paid).
// The price tier (50/80) + payment method are chosen by จ้อจี้ at scan time — NOT
// here. Returns a one-time token the client renders as a QR.

export async function POST(_req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.activeBranchId == null) {
    return NextResponse.json({ error: "no_branch" }, { status: 400 });
  }

  const result = createDrinkOrder(user.id, user.activeBranchId);
  if (!result.ok) {
    const status = result.error === "not_clocked_in" ? 409 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  logPersonaAction(user.id, "drink_order.create", result.orderId);

  return NextResponse.json({
    ok: true,
    token: result.token,
    expiresAt: result.expiresAt,
    partnerName: result.partnerName
  });
}
