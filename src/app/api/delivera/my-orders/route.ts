import { NextResponse } from "next/server";
import { customerLineReady } from "@/lib/delivera/env";
import { verifyAccessToken } from "@/lib/delivera/line";
import { listCustomerOrders } from "@/lib/delivera/orders";

// Public (customer LIFF): the caller's own recent orders. Identity proven via the
// LIFF token → LINE userId → customer_hash, so only their orders come back.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!customerLineReady()) return NextResponse.json({ error: "delivera_line_not_configured" }, { status: 503 });
  const prof = await verifyAccessToken(token);
  if (!prof) return NextResponse.json({ error: "line_auth_failed" }, { status: 401 });
  return NextResponse.json({ ok: true, orders: listCustomerOrders(prof.userId) });
}
