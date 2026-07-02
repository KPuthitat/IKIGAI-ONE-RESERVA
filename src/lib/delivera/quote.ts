import { getDb } from "@/lib/db";
import { haversineKm, type LatLng } from "./distance";

// Delivery quote engine. Pure, distance-driven helpers (selectZone / feeForZone
// / quoteFromDistance) sit under the DB-backed quote(), so the fee + zone logic
// is unit-tested without a database or coordinates.

export class OutOfZoneError extends Error {
  constructor(public readonly distanceKm: number) {
    super(`out_of_zone:${distanceKm}`);
    this.name = "OutOfZoneError";
  }
}

export type Zone = {
  id: number;
  name: string;
  max_distance_km: number;
  base_fee: number;
  per_km_fee: number;
  min_order_amount: number;
};

export type QuoteResult = {
  zoneId: number;
  zoneName: string;
  distanceKm: number;
  deliveryFee: number;
  minOrder: number;
  meetsMin: boolean;
};

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Narrowest active zone whose reach still covers the distance, or null. Ties
 *  broken by lower fee then id, for determinism. */
export function selectZone(zones: Zone[], distanceKm: number): Zone | null {
  const covering = zones
    .filter((z) => distanceKm <= z.max_distance_km)
    .sort((a, b) => a.max_distance_km - b.max_distance_km || a.base_fee - b.base_fee || a.id - b.id);
  return covering[0] ?? null;
}

/** fee = base_fee + per_km_fee × max(0, distanceKm − 1). First km is included
 *  in the base fee. */
export function feeForZone(zone: Zone, distanceKm: number): number {
  return round2(zone.base_fee + zone.per_km_fee * Math.max(0, distanceKm - 1));
}

export function quoteFromDistance(args: { distanceKm: number; subtotal: number; zones: Zone[] }): QuoteResult {
  const distanceKm = round2(args.distanceKm);
  const zone = selectZone(args.zones, distanceKm);
  if (!zone) throw new OutOfZoneError(distanceKm);
  return {
    zoneId: zone.id,
    zoneName: zone.name,
    distanceKm,
    deliveryFee: feeForZone(zone, distanceKm),
    minOrder: zone.min_order_amount,
    meetsMin: args.subtotal >= zone.min_order_amount
  };
}

export function quoteFromCoords(args: { origin: LatLng; dest: LatLng; subtotal: number; zones: Zone[] }): QuoteResult {
  return quoteFromDistance({
    distanceKm: haversineKm(args.origin, args.dest),
    subtotal: args.subtotal,
    zones: args.zones
  });
}

/** DB-backed quote for a branch: reads the branch origin + its active zones.
 *  Throws OutOfZoneError when beyond every zone; branch_no_location when the
 *  branch has no coordinates set. */
export function quote(args: { branchId: number; destLat: number; destLng: number; subtotal: number }): QuoteResult {
  const db = getDb();
  const branch = db
    .prepare("SELECT latitude AS lat, longitude AS lng FROM branches WHERE id = ?")
    .get(args.branchId) as { lat: number | null; lng: number | null } | undefined;
  if (!branch || branch.lat == null || branch.lng == null) throw new Error("branch_no_location");
  const zones = db
    .prepare(
      `SELECT id, name, max_distance_km, base_fee, per_km_fee, min_order_amount
         FROM delivery_zones WHERE branch_id = ? AND is_active = 1`
    )
    .all(args.branchId) as Zone[];
  return quoteFromCoords({
    origin: { lat: branch.lat, lng: branch.lng },
    dest: { lat: args.destLat, lng: args.destLng },
    subtotal: args.subtotal,
    zones
  });
}
