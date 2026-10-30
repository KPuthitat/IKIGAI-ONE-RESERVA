import { NextResponse } from "next/server";
import { GuestError, guestMarkPaid } from "@/lib/delivera/guest";

// Public: "I have paid by PromptPay" — the order waits for the manager to confirm the money arrived.
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { token: string } }) {
  try { guestMarkPaid(params.token); return NextResponse.json({ ok: true }); }
  catch (e) {
    if (e instanceof GuestError) return NextResponse.json({ error: e.code }, { status: e.code === "order_not_found" ? 404 : 409 });
    throw e;
  }
}
