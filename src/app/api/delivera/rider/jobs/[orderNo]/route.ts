import { NextResponse } from "next/server";
import { RiderJobActionBody } from "@/lib/delivera/validate";
import { riderLineReady } from "@/lib/delivera/env";
import { verifyAccessToken } from "@/lib/delivera/line";
import { getOrderByNo, OrderError } from "@/lib/delivera/orders";
import { getRiderByLine, riderAccept, riderPickup, riderDeliver } from "@/lib/delivera/rider";

// Rider LIFF: progress a job — accept, mark picked up, or delivered. Guarded to
// the job's own rider (rider.ts rejects a job that isn't theirs).
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { orderNo: string } }) {
  const parsed = RiderJobActionBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  if (!riderLineReady()) return NextResponse.json({ error: "rider_channel_not_configured" }, { status: 503 });

  const prof = await verifyAccessToken(parsed.data.access_token);
  if (!prof) return NextResponse.json({ error: "line_auth_failed" }, { status: 401 });
  const rider = getRiderByLine(prof.userId);
  if (!rider) return NextResponse.json({ error: "not_registered" }, { status: 404 });
  const order = getOrderByNo(params.orderNo);
  if (!order) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    if (parsed.data.action === "accept") { riderAccept(order.id, rider.id); return NextResponse.json({ ok: true }); }
    if (parsed.data.action === "pickup") { return NextResponse.json({ ok: true, status: riderPickup(order.id, rider.id) }); }
    return NextResponse.json({ ok: true, status: riderDeliver(order.id, rider.id, parsed.data.proof_photo_url ?? null) });
  } catch (e) {
    if (e instanceof OrderError) return NextResponse.json({ error: e.code, detail: e.detail }, { status: 400 });
    return NextResponse.json({ error: "action_failed", message: (e as Error).message }, { status: 400 });
  }
}
