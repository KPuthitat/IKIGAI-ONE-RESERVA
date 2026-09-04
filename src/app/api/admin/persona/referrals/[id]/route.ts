import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { verifyAdminPin } from "@/lib/admin-pin";
import { payReferral } from "@/lib/referral";

// PATCH /api/admin/persona/referrals/[id]
//   { action: "pay", admin_pin }  → post the 500฿ reward into the referrer's
//   current open (draft) payroll round + mark the referral paid. PIN-gated.

const Body = z.object({
  action: z.literal("pay"),
  admin_pin: z.string().optional()
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const referralId = Number(params.id);
  if (!Number.isInteger(referralId) || referralId <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  if (!parsed.data.admin_pin) return NextResponse.json({ error: "pin_required" }, { status: 400 });
  const pin = verifyAdminPin(user.id, parsed.data.admin_pin);
  if (!pin.ok) {
    return NextResponse.json({ error: pin.reason }, { status: pin.reason === "no_pin" ? 400 : 403 });
  }

  const db = getDb();
  const res = payReferral(db, referralId);
  if (!res.ok) {
    const status = res.reason === "not_found" ? 404 : 400;
    return NextResponse.json({ error: res.reason }, { status });
  }
  logPersonaAction(user.id, "referral.pay", referralId);
  return NextResponse.json({ ok: true, periodId: res.periodId, amount: res.amount });
}
