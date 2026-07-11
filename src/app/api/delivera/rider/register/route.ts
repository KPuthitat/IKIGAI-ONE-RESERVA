import { NextResponse } from "next/server";
import { RiderRegisterBody } from "@/lib/delivera/validate";
import { isDeliveraBranch } from "@/lib/delivera/db";
import { riderLineReady } from "@/lib/delivera/env";
import { verifyAccessToken } from "@/lib/delivera/line";
import { registerRider, completeRiderRegistration } from "@/lib/delivera/rider";

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

  // Identity row first (creates on first open; never flips is_registered).
  let rider = registerRider({
    branchId: parsed.data.branch_id, lineUserId: prof.userId, displayName: prof.displayName || "ทีมงานส่งสุข"
  });
  // A submitted phone means the rider is completing registration.
  if (parsed.data.phone && parsed.data.phone.trim()) {
    rider = completeRiderRegistration(rider.id, {
      displayName: prof.displayName || null, phone: parsed.data.phone.trim(),
      vehicleType: parsed.data.vehicle_type ?? null, plate: parsed.data.plate ?? null,
      plateProvince: parsed.data.plate_province ?? null, engineType: parsed.data.engine_type ?? null
    });
  }
  return NextResponse.json({
    ok: true,
    rider: {
      id: rider.id, display_name: rider.display_name, status: rider.status,
      is_registered: rider.is_registered === 1,
      phone: rider.phone, vehicle_type: rider.vehicle_type, plate: rider.plate, plate_province: rider.plate_province, engine_type: rider.engine_type
    }
  });
}
