import { NextResponse } from "next/server";
import { RiderHeartbeatBody } from "@/lib/delivera/validate";
import { riderLineReady } from "@/lib/delivera/env";
import { verifyAccessToken } from "@/lib/delivera/line";
import { getRiderByLine, updateRiderLocation } from "@/lib/delivera/rider";

// Rider LIFF: GPS heartbeat — feeds "who's nearby" dispatch. A fresh heartbeat
// flips an offline rider to available (busy riders stay busy).
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const parsed = RiderHeartbeatBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  if (!riderLineReady()) return NextResponse.json({ error: "rider_channel_not_configured" }, { status: 503 });

  const prof = await verifyAccessToken(parsed.data.access_token);
  if (!prof) return NextResponse.json({ error: "line_auth_failed" }, { status: 401 });
  const rider = getRiderByLine(prof.userId);
  if (!rider) return NextResponse.json({ error: "not_registered" }, { status: 404 });

  updateRiderLocation(rider.id, parsed.data.lat, parsed.data.lng);
  return NextResponse.json({ ok: true });
}
