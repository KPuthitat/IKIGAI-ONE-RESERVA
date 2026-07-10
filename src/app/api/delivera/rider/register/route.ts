import { NextResponse } from "next/server";
import { RiderRegisterBody } from "@/lib/delivera/validate";
import { isDeliveraBranch } from "@/lib/delivera/db";
import { riderLineReady } from "@/lib/delivera/env";
import { verifyAccessToken } from "@/lib/delivera/line";
import { registerRider } from "@/lib/delivera/rider";

// Rider LIFF (IKIGAI RIDER channel): register/refresh the rider profile from the
// verified LINE identity. Idempotent — re-opening the LIFF updates the record.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const parsed = RiderRegisterBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  if (!riderLineReady()) return NextResponse.json({ error: "rider_channel_not_configured" }, { status: 503 });
  if (!isDeliveraBranch(parsed.data.branch_id)) return NextResponse.json({ error: "branch_unavailable" }, { status: 404 });

  const prof = await verifyAccessToken(parsed.data.access_token);
  if (!prof) return NextResponse.json({ error: "line_auth_failed" }, { status: 401 });

  const rider = registerRider({
    branchId: parsed.data.branch_id, lineUserId: prof.userId, displayName: prof.displayName || "ไรเดอร์",
    phone: parsed.data.phone ?? null, vehicleType: parsed.data.vehicle_type ?? null, plate: parsed.data.plate ?? null
  });
  return NextResponse.json({ ok: true, rider: { id: rider.id, display_name: rider.display_name, status: rider.status } });
}
