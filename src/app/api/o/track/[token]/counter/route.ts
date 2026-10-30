import { NextResponse } from "next/server";
import { GuestError, guestPayAtCounter } from "@/lib/delivera/guest";

// Public: "I'll pay at the counter" — the kitchen starts right away and staff collect the money at hand-over.
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { token: string } }) {
  try { guestPayAtCounter(params.token); return NextResponse.json({ ok: true }); }
  catch (e) {
    if (e instanceof GuestError) return NextResponse.json({ error: e.code, message: e.code === "cod_disabled" ? "ร้านนี้ไม่รับชำระที่เคาน์เตอร์" : undefined }, { status: e.code === "order_not_found" ? 404 : 409 });
    throw e;
  }
}
