import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, logPersonaAction } from "@/lib/db";
import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { verifyAdminPin } from "@/lib/admin-pin";
import { PaymentError, voidPayment } from "@/lib/special-payments";
import { canPayUser, PAYMENT_ERROR_TH } from "@/lib/special-payments-access";

const Body = z.object({ reason: z.string().trim().min(3).max(300), admin_pin: z.string().optional() });

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden", message: PAYMENT_ERROR_TH.forbidden }, { status: 403 });
  const id = Number(params.id);
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!Number.isInteger(id) || !parsed.success) return NextResponse.json({ error: "invalid_body", message: PAYMENT_ERROR_TH.invalid_body }, { status: 400 });
  if (!parsed.data.admin_pin) return NextResponse.json({ error: "pin_required", message: PAYMENT_ERROR_TH.pin_required }, { status: 400 });
  const pin = verifyAdminPin(user.id, parsed.data.admin_pin);
  if (!pin.ok) return NextResponse.json({ error: pin.reason, message: PAYMENT_ERROR_TH[pin.reason as "no_pin" | "wrong_pin"] ?? "PIN ไม่ถูกต้อง" }, { status: pin.reason === "no_pin" ? 400 : 403 });
  const row = getDb().prepare("SELECT user_id FROM staff_special_payments WHERE id = ?").get(id) as { user_id: number } | undefined;
  if (!row) return NextResponse.json({ error: "not_found", message: PAYMENT_ERROR_TH.not_found }, { status: 404 });
  if (!canPayUser(user, row.user_id)) return NextResponse.json({ error: "forbidden", message: PAYMENT_ERROR_TH.forbidden }, { status: 403 });
  try {
    voidPayment({ id, reason: parsed.data.reason, actorId: user.id });
    logPersonaAction(user.id, "special_payment.void", id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof PaymentError) return NextResponse.json({ error: e.code, message: PAYMENT_ERROR_TH[e.code] }, { status: 422 });
    throw e;
  }
}
