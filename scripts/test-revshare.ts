// Unit tests for the Revenue-Share GP core calc. Run: npm run test:revshare
// Covers acceptance criteria 1–5 (POS parser = test-revshare-pos via RS3).
import {
  marginalGP, computeSettlement, computeRoundBreakdown, opMonthFor, floorFor,
  DEFAULT_TIERS, DEFAULT_FLOORS, roundLabel, salesVat, salesBaseIncludesVat, partnerShopName, type Floor
} from "../src/lib/revshare";

let failed = 0;
function eq(name: string, got: number, want: number, tol = 0.005): void {
  if (Math.abs(got - want) > tol) {
    console.error(`✗ ${name}: got ${got}, want ${want}`);
    failed++;
  } else {
    console.log(`✓ ${name} = ${got}`);
  }
}
function ok(name: string, cond: boolean): void {
  if (!cond) { console.error(`✗ ${name}`); failed++; } else console.log(`✓ ${name}`);
}

// Engine tests use an explicit tiered floor fixture so they validate the calc
// independently of whatever the DEFAULT_FLOORS template happens to be.
const T = DEFAULT_TIERS;
const F: Floor[] = [
  { monthFrom: 1, monthTo: 2, amount: 15_000 },
  { monthFrom: 3, monthTo: 4, amount: 18_000 },
  { monthFrom: 5, monthTo: 6, amount: 20_000 }
];

// 1) totalSales 400,000 · opMonth 1
{
  const s = computeSettlement({ totalSales: 400_000, opMonth: 1, tiers: T, floors: F, vatEnabled: true, vatRate: 0.07, whtRate: 0.03 });
  eq("1.tierGP", s.tierGP, 66_000);
  eq("1.floor", s.floorApplied, 15_000);
  eq("1.billedGP", s.billedGP, 66_000);
  eq("1.topup", s.topup, 0);
  eq("1.avgGpPct%", s.avgGpPct * 100, 16.5);
  eq("1.vat", s.vatAmount, 4_620);
  eq("1.wht", s.whtAmount, 1_980);
  eq("1.net", s.netAmount, 68_640);
}

// 2) totalSales 15,000 · opMonth 1 (floor binds)
{
  const s = computeSettlement({ totalSales: 15_000, opMonth: 1, tiers: T, floors: F, vatEnabled: true, vatRate: 0.07, whtRate: 0.03 });
  eq("2.tierGP", s.tierGP, 2_700);
  eq("2.floor", s.floorApplied, 15_000);
  eq("2.billedGP", s.billedGP, 15_000);
  eq("2.topup", s.topup, 12_300);
  eq("2.vat", s.vatAmount, 1_050);
  eq("2.wht", s.whtAmount, 450);
  eq("2.net", s.netAmount, 15_600);
}

// 3) reconcile: rounds 120k / 90k / 110k / 80k → cumulative GP diffs
{
  const rows = computeRoundBreakdown([120_000, 90_000, 110_000, 80_000], T);
  eq("3.round1", rows[0].roundGP, 21_600);
  eq("3.round2", rows[1].roundGP, 15_900);
  eq("3.round3", rows[2].roundGP, 16_500);
  eq("3.round4", rows[3].roundGP, 12_000);
  const sum = rows.reduce((a, r) => a + r.roundGP, 0);
  eq("3.sum == tierGP(400k)", sum, marginalGP(400_000, T));
}

// 4) totalSales 1,000,000 · opMonth 8 (no floor)
{
  const s = computeSettlement({ totalSales: 1_000_000, opMonth: 8, tiers: T, floors: F, vatEnabled: true, vatRate: 0.07, whtRate: 0.03 });
  eq("4.tierGP", s.tierGP, 131_000);
  eq("4.floor", s.floorApplied, 0);
  eq("4.avgGpPct%", s.avgGpPct * 100, 13.1);
  eq("4.vat", s.vatAmount, 9_170);
  eq("4.wht", s.whtAmount, 3_930);
  eq("4.net", s.netAmount, 136_240);
}

// 5) cliff check — boundary must not drop GP
{
  const at = marginalGP(200_000, T);
  const past = marginalGP(200_001, T);
  eq("5.at200k", at, 36_000);
  ok("5.no-cliff (past >= at)", past >= at);
}

// extra: VAT off → no VAT line; opMonth math; round label
{
  const s = computeSettlement({ totalSales: 400_000, opMonth: 1, tiers: T, floors: F, vatEnabled: false, vatRate: 0.07, whtRate: 0.03 });
  eq("x.vatOff", s.vatAmount, 0);
  eq("x.netNoVat", s.netAmount, 66_000 - 1_980);
  eq("x.opMonth jan→jan", opMonthFor("2026-01-15", 2026, 1), 1);
  eq("x.opMonth jan→aug", opMonthFor("2026-01-15", 2026, 8), 8);
  ok("x.roundLabel same-month", roundLabel("2026-06-15", "2026-06-21") === "15–21 มิถุนายน 2569");
  ok("x.roundLabel cross-month", roundLabel("2026-06-30", "2026-07-06") === "30 มิถุนายน – 6 กรกฎาคม 2569");
  ok("x.roundLabel single", roundLabel("2026-06-19", "2026-06-19") === "19 มิถุนายน 2569");
}

// default floor template = flat 20,000/month (owner 2026-06-23)
{
  ok("x.defaultFloor flat 20k m1", floorFor(1, DEFAULT_FLOORS) === 20_000);
  ok("x.defaultFloor flat 20k m12", floorFor(12, DEFAULT_FLOORS) === 20_000);
}

// salesVat — daily/weekly card VAT split honours sales_base (owner 2026-07-25).
// The 2,630 pre-VAT figure that surfaced the bug: was shown as base 2,457.94
// (÷1.07); must be base 2,630 + VAT 184.10.
{
  const pre = salesVat(2630, 0.07, false); // gross/after_discount → add on top
  eq("vat.gross base", pre.base, 2630);
  eq("vat.gross vat", pre.vat, 184.1);
  eq("vat.gross total", pre.total, 2814.1);

  const inc = salesVat(2630, 0.07, true); // nett → already carries VAT, divide out
  eq("vat.nett base", inc.base, 2457.94);
  eq("vat.nett vat", inc.vat, 172.06);
  eq("vat.nett total", inc.total, 2630);

  ok("vat.base gross is pre-VAT", salesBaseIncludesVat("gross") === false);
  ok("vat.base after_discount is pre-VAT", salesBaseIncludesVat("after_discount") === false);
  ok("vat.base nett is VAT-inclusive", salesBaseIncludesVat("nett") === true);
}

// partnerShopName — card header shows one name, not the joined POS categories
// (owner 2026-07-25). venue wins when set, else the partner name.
{
  ok("shop.name only", partnerShopName({ name: "จ้อจี้ & friends" }) === "จ้อจี้ & friends");
  ok("shop.venue wins", partnerShopName({ name: "จ้อจี้ & friends", venue: "สาขาศรีราชา" }) === "สาขาศรีราชา");
  ok("shop.blank venue falls back", partnerShopName({ name: "จ้อจี้ & friends", venue: "  " }) === "จ้อจี้ & friends");
}

// Staff drink-welfare passthrough (owner 2026-07-30): the coupon total nets
// against the GP invoice with NO GP taken; drink amount is VAT-inclusive.
{
  const T = [{ lower: 0, upper: null, rate: 0.2 }];
  const F: { monthFrom: number; monthTo: number; amount: number }[] = [];
  // 400k sales → tierGP 80k; VAT 5600; WHT 2400 → net 83,200 (จ้อจี้ pays บริษัท).
  const base = computeSettlement({ totalSales: 400_000, opMonth: 1, tiers: T, floors: F, vatEnabled: true, vatRate: 0.07, whtRate: 0.03 });
  eq("drink.baseNet", base.netAmount, 83_200);
  eq("drink.base passthrough 0", base.drinkPassthrough, 0);
  eq("drink.base netAfter = net", base.netAfterDrinks, base.netAmount);

  // + 1,300 drinks (e.g. 10×80 + 10×50) → nets against GP: 83,200 − 1,300.
  const withDrinks = computeSettlement({ totalSales: 400_000, opMonth: 1, tiers: T, floors: F, vatEnabled: true, vatRate: 0.07, whtRate: 0.03, drinkPassthrough: 1_300 });
  eq("drink.gpNet unchanged (no GP on drinks)", withDrinks.netAmount, 83_200);
  eq("drink.passthrough", withDrinks.drinkPassthrough, 1_300);
  eq("drink.netAfter", withDrinks.netAfterDrinks, 81_900);
  eq("drink.inputVat 7/107", withDrinks.drinkInputVat, Math.round((1_300 * 7 / 107) * 100) / 100);

  // Drinks exceed GP → company pays partner (negative net).
  const flip = computeSettlement({ totalSales: 0, opMonth: 1, tiers: T, floors: F, vatEnabled: true, vatRate: 0.07, whtRate: 0.03, drinkPassthrough: 500 });
  eq("drink.flip netAfter negative", flip.netAfterDrinks, -500);
}

// Combined multi-month settlement (owner 2026-08): GP on the COMBINED total
// (progressive tiers see the whole span) and floor = sum of each month's floor.
{
  const combined = computeSettlement({
    totalSales: 500_000, opMonth: 2, tiers: T, floors: F, floorOverride: 30_000,
    vatEnabled: true, vatRate: 0.07, whtRate: 0.03
  });
  eq("combine.tierGP(500k)", combined.tierGP, 81_000);      // 200k*.18 + 150k*.15 + 150k*.15
  eq("combine.floor summed(15k+15k)", combined.floorApplied, 30_000);
  eq("combine.billedGP", combined.billedGP, 81_000);
  // Combining is NOT the same as settling each 250k month separately: progressive
  // tiers push more volume into lower rates, so combined GP is lower.
  const separate = marginalGP(250_000, T) * 2;                // 43,500 * 2 = 87,000
  ok("combine.progressive < separate", combined.tierGP < separate);
  // floorOverride wins over the single end-month floorFor path.
  const floorWins = computeSettlement({
    totalSales: 10_000, opMonth: 2, tiers: T, floors: F, floorOverride: 30_000,
    vatEnabled: false, vatRate: 0.07, whtRate: 0.03
  });
  eq("combine.floorOverride applies", floorWins.billedGP, 30_000);
}

if (failed > 0) {
  console.error(`\nREVSHARE TESTS FAILED: ${failed}`);
  process.exit(1);
}
console.log("\nrevshare: all tests passed");
