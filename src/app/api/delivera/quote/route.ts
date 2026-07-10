import { NextResponse } from "next/server";
import { QuoteBody } from "@/lib/delivera/validate";
import { isDeliveraBranch } from "@/lib/delivera/db";
import { quote, OutOfZoneError } from "@/lib/delivera/quote";

// Public: preview the delivery fee for a cart before ordering. The SAME quote()
// is recomputed at order creation — this endpoint is display-only.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const parsed = QuoteBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const d = parsed.data;
  if (!isDeliveraBranch(d.branch_id)) return NextResponse.json({ error: "branch_unavailable" }, { status: 404 });
  try {
    const q = quote({ branchId: d.branch_id, destLat: d.dest_lat, destLng: d.dest_lng, subtotal: d.subtotal });
    return NextResponse.json({ ok: true, quote: q });
  } catch (e) {
    if (e instanceof OutOfZoneError) {
      return NextResponse.json({ error: "out_of_zone", distance_km: e.distanceKm }, { status: 422 });
    }
    return NextResponse.json({ error: "quote_failed", message: (e as Error).message }, { status: 400 });
  }
}
