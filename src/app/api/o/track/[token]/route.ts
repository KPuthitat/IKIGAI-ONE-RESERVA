import { NextResponse } from "next/server";
import { guestPayInfo, guestView } from "@/lib/delivera/guest";

// Public: the owner of a walk-in order (found by its unguessable token) polls this for status, queue and the payment QR.
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { token: string } }) {
  const view = guestView(params.token);
  if (!view) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const pay = view.status === "pending_payment" ? guestPayInfo(params.token) : null;
  return NextResponse.json({ ok: true, order: view, pay });
}
