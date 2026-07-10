import { NextResponse } from "next/server";
import { customerLineReady } from "@/lib/delivera/env";
import { verifyAccessToken } from "@/lib/delivera/line";
import { getOrderForCustomer } from "@/lib/delivera/orders";

// Public (customer LIFF): order tracking. Ownership is proven by verifying the
// caller's LIFF token → LINE userId → customer_hash match, so a guessed
// order_no can't reveal someone else's order. Only public-safe fields returned.
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { orderNo: string } }) {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!customerLineReady()) return NextResponse.json({ error: "delivera_line_not_configured" }, { status: 503 });
  const prof = await verifyAccessToken(token);
  if (!prof) return NextResponse.json({ error: "line_auth_failed" }, { status: 401 });
  const o = getOrderForCustomer(params.orderNo, prof.userId);
  if (!o) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, order: o });
}
