import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { isDeliveraBranch } from "@/lib/delivera/db";
import { listAvailableRidersNear } from "@/lib/delivera/rider";

// Admin (session): available riders for the active branch, nearest-to-the-shop
// first — the "who's nearby" list the dispatcher picks from.
export const dynamic = "force-dynamic";

export async function GET() {
  const user = requirePermission("delivera.manage");
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  if (!isDeliveraBranch(user.activeBranchId)) return NextResponse.json({ error: "delivera_disabled" }, { status: 404 });
  const riders = listAvailableRidersNear(user.activeBranchId).map(({ rider, distanceKm }) => ({
    id: rider.id, name: rider.display_name, vehicle: rider.vehicle_type, plate: rider.plate,
    distance_km: distanceKm, last_seen: rider.last_location_at
  }));
  return NextResponse.json({ ok: true, riders });
}
