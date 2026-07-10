// Distance for delivery quoting. Starts with Haversine (straight-line) and
// exposes a DistanceProvider interface so a road-distance provider (Google
// Distance Matrix) can be swapped in later without touching the quote engine.

export type LatLng = { lat: number; lng: number };

export interface DistanceProvider {
  /** Distance origin→dest in kilometres. */
  distanceKm(origin: LatLng, dest: LatLng): Promise<number>;
}

const EARTH_RADIUS_KM = 6371;

export function haversineKm(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const haversineProvider: DistanceProvider = {
  async distanceKm(origin, dest) {
    return haversineKm(origin, dest);
  }
};

// ASSUMPTION: GOOGLE_MAPS_API_KEY, when set, will back a GoogleDistanceProvider
// implementing DistanceProvider — added later. Haversine is the default so the
// quote engine works with zero external config.
