import { NextResponse } from "next/server";
import { CreateOrderBody, toCreateOrderInput } from "@/lib/delivera/validate";
import { isDeliveraBranch } from "@/lib/delivera/db";
import { customerLineReady } from "@/lib/delivera/env";
import { verifyAccessToken } from "@/lib/delivera/line";
import { createOrder, OrderError } from "@/lib/delivera/orders";

// Public (customer LIFF): create an order. The LIFF access token is verified
// server-side to get the LINE userId (hashed into customer_hash); prices AND
// the delivery fee are recomputed in createOrder — the client's figures are
// never trusted.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const parsed = CreateOrderBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  if (!isDeliveraBranch(d.branch_id)) return NextResponse.json({ error: "branch_unavailable" }, { status: 404 });
  if (!customerLineReady()) return NextResponse.json({ error: "delivera_line_not_configured" }, { status: 503 });

  const prof = await verifyAccessToken(d.access_token);
  if (!prof) return NextResponse.json({ error: "line_auth_failed" }, { status: 401 });

  try {
    const input = toCreateOrderInput(d, prof.userId);
    if (!input.customerDisplayName) input.customerDisplayName = prof.displayName || null;
    const r = createOrder(input);
    return NextResponse.json({
      ok: true, order_no: r.orderNo, subtotal: r.subtotal, delivery_fee: r.deliveryFee, total: r.total
    });
  } catch (e) {
    if (e instanceof OrderError) return NextResponse.json({ error: e.code, detail: e.detail }, { status: 400 });
    return NextResponse.json({ error: "order_failed", message: (e as Error).message }, { status: 400 });
  }
}
