import { NextResponse } from "next/server";
import { riderLineReady } from "@/lib/delivera/env";
import { verifyAccessToken } from "@/lib/delivera/line";
import { getRiderByLine, riderMonthlyStats } from "@/lib/delivera/rider";

// Rider LIFF: the rider's own profile + monthly delivery performance (baht value
// handled through the system). Identity via the LIFF token → line_user_id.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!riderLineReady()) return NextResponse.json({ error: "rider_channel_not_configured" }, { status: 503 });
  const prof = await verifyAccessToken(token);
  if (!prof) return NextResponse.json({ error: "line_auth_failed" }, { status: 401 });
  const rider = getRiderByLine(prof.userId);
  if (!rider) return NextResponse.json({ error: "not_registered" }, { status: 404 });

  return NextResponse.json({
    ok: true,
    profile: {
      display_name: rider.display_name, phone: rider.phone,
      vehicle_type: rider.vehicle_type, engine_type: rider.engine_type,
      plate: rider.plate, plate_province: rider.plate_province,
      is_registered: rider.is_registered === 1
    },
    months: riderMonthlyStats(rider.id, 6)
  });
}
