// Unit tests for the DELIVERA quote engine. Run: npm run test:delivera
import {
  selectZone, feeForZone, quoteFromDistance, OutOfZoneError, round2, type Zone
} from "../src/lib/delivera/quote";
import { haversineKm } from "../src/lib/delivera/distance";

let failed = 0;
function eq(name: string, got: number, want: number, tol = 0.005): void {
  if (Math.abs(got - want) > tol) { console.error(`✗ ${name}: got ${got}, want ${want}`); failed++; }
  else console.log(`✓ ${name} = ${got}`);
}
function ok(name: string, cond: boolean): void {
  if (!cond) { console.error(`✗ ${name}`); failed++; } else console.log(`✓ ${name}`);
}

const ZONES: Zone[] = [
  { id: 1, name: "ใกล้", max_distance_km: 3, base_fee: 20, per_km_fee: 0, min_order_amount: 100 },
  { id: 2, name: "ไกล", max_distance_km: 7, base_fee: 30, per_km_fee: 8, min_order_amount: 150 }
];

// 1) narrowest-first: 2km covered by both → picks near zone (id 1)
{
  const q = quoteFromDistance({ distanceKm: 2, subtotal: 200, zones: ZONES });
  ok("1.picks narrow zone", q.zoneId === 1);
  eq("1.fee (per_km 0)", q.deliveryFee, 20);
  ok("1.meetsMin", q.meetsMin === true);
}

// 2) exact edge of near zone (3.0) still counts as covered
{
  const q = quoteFromDistance({ distanceKm: 3, subtotal: 200, zones: ZONES });
  ok("2.edge stays near zone", q.zoneId === 1);
  eq("2.fee", q.deliveryFee, 20);
}

// 3) just past near zone → far zone; fee = 30 + 8*(3.01-1)
{
  const q = quoteFromDistance({ distanceKm: 3.01, subtotal: 200, zones: ZONES });
  ok("3.falls to far zone", q.zoneId === 2);
  eq("3.fee", q.deliveryFee, 30 + 8 * 2.01);
}

// 4) below min order → meetsMin false (still quotes a fee)
{
  const q = quoteFromDistance({ distanceKm: 5, subtotal: 120, zones: ZONES });
  ok("4.far zone", q.zoneId === 2);
  ok("4.below min", q.meetsMin === false);
  eq("4.minOrder", q.minOrder, 150);
}

// 5) edge of far zone (7.0) covered; 7.01 out of zone → throws
{
  const q = quoteFromDistance({ distanceKm: 7, subtotal: 200, zones: ZONES });
  eq("5.far edge fee", q.deliveryFee, 30 + 8 * 6);
  let threw = false;
  try { quoteFromDistance({ distanceKm: 7.01, subtotal: 200, zones: ZONES }); }
  catch (e) { threw = e instanceof OutOfZoneError; }
  ok("5.out of zone throws", threw);
}

// 6) fee rounding to 2 dp
{
  const z: Zone = { id: 9, name: "z", max_distance_km: 10, base_fee: 30, per_km_fee: 8, min_order_amount: 0 };
  eq("6.fee rounds", feeForZone(z, 1.333), round2(30 + 8 * 0.333)); // 32.66
  ok("6.round2", round2(32.664) === 32.66);
}

// 7) selectZone returns null when beyond all
ok("7.selectZone null", selectZone(ZONES, 99) === null);

// 8) haversine sanity: 1° of latitude ≈ 111.19 km; identical points = 0
eq("8.haversine 1deg lat", haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }), 111.19, 0.3);
eq("8.haversine same point", haversineKm({ lat: 13.75, lng: 100.5 }, { lat: 13.75, lng: 100.5 }), 0);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
