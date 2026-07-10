import { NextResponse } from "next/server";
import { riderLineReady } from "@/lib/delivera/env";
import { verifyAccessToken } from "@/lib/delivera/line";
import { getRiderByLine, listRiderJobs } from "@/lib/delivera/rider";
import { decryptSecret } from "@/lib/secret-vault";

// Rider LIFF: my active jobs. Returns delivery-facing detail (address + the
// customer phone, decrypted here so the rider can call) — riders only ever see
// jobs assigned to them.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!riderLineReady()) return NextResponse.json({ error: "rider_channel_not_configured" }, { status: 503 });
  const prof = await verifyAccessToken(token);
  if (!prof) return NextResponse.json({ error: "line_auth_failed" }, { status: 401 });
  const rider = getRiderByLine(prof.userId);
  if (!rider) return NextResponse.json({ error: "not_registered" }, { status: 404 });

  const jobs = listRiderJobs(rider.id).map(({ order, delivery }) => ({
    order_no: order.order_no,
    status: order.status,
    fulfillment: order.fulfillment,
    dest_address: order.dest_address,
    dest_lat: order.dest_lat,
    dest_lng: order.dest_lng,
    customer_name: order.customer_display_name,
    phone: order.phone_enc ? safeDecrypt(order.phone_enc) : null,
    total: order.total,
    pay_method: order.pay_method,
    cod_amount: delivery.cod_amount,
    note: order.note,
    accepted: !!delivery.accepted_at,
    picked_up: !!delivery.picked_up_at
  }));
  return NextResponse.json({ ok: true, rider: { id: rider.id, status: rider.status }, jobs });
}

function safeDecrypt(enc: string): string | null {
  try { return decryptSecret(enc); } catch { return null; }
}
