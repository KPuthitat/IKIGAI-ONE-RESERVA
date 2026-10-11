import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { verifyAdminPin } from "@/lib/admin-pin";
import { listPayments, PaymentError, recordPayment } from "@/lib/special-payments";
import { canPayUser, PAYMENT_ERROR_TH } from "@/lib/special-payments-access";

// GET  ?month=YYYY-MM          → ledger rows of that month (voided ones included, flagged)
// POST {user_id, kind, paid_on, amount, reason, admin_pin}  → PIN-gated record

export async function GET(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const month = new URL(req.url).searchParams.get("month") ?? "";
  if (!/^\d{4}-\d{2}$/.test(month)) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  return NextResponse.json({ ok: true, payments: listPayments({ yearMonth: month }).filter((p) => canPayUser(user, p.userId)) });
}

const Body = z.object({
  user_id: z.number().int().positive(),
  kind: z.enum(["aid", "advance"]),
  paid_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.number().positive().max(1_000_000),
  reason: z.string().trim().min(3).max(300),
  admin_pin: z.string().optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden", message: PAYMENT_ERROR_TH.forbidden }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", message: PAYMENT_ERROR_TH.invalid_body }, { status: 400 });
  const d = parsed.data;
  if (!d.admin_pin) return NextResponse.json({ error: "pin_required", message: PAYMENT_ERROR_TH.pin_required }, { status: 400 });
  const pin = verifyAdminPin(user.id, d.admin_pin);
  if (!pin.ok) return NextResponse.json({ error: pin.reason, message: PAYMENT_ERROR_TH[pin.reason as "no_pin" | "wrong_pin"] ?? "PIN ไม่ถูกต้อง" }, { status: pin.reason === "no_pin" ? 400 : 403 });
  if (!canPayUser(user, d.user_id)) return NextResponse.json({ error: "forbidden", message: PAYMENT_ERROR_TH.forbidden }, { status: 403 });
  try {
    const id = recordPayment({ userId: d.user_id, kind: d.kind, paidOn: d.paid_on, amount: d.amount, reason: d.reason, actorId: user.id });
    logPersonaAction(user.id, `special_payment.${d.kind}`, id);
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    if (e instanceof PaymentError) return NextResponse.json({ error: e.code, message: PAYMENT_ERROR_TH[e.code], available: e.detail?.available }, { status: 422 });
    throw e;
  }
}
