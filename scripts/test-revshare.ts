// Unit tests for the Revenue-Share GP core calc. Run: npm run test:revshare
// Covers acceptance criteria 1–5 (POS parser = test-revshare-pos via RS3).
import {
  marginalGP, computeSettlement, computeRoundBreakdown, opMonthFor,
  DEFAULT_TIERS, DEFAULT_FLOORS, roundLabel
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

const T = DEFAULT_TIERS, F = DEFAULT_FLOORS;

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
  ok("x.roundLabel same-month", roundLabel("2026-06-15", "2026-06-21") === "15–21 มิ.ย.");
  ok("x.roundLabel cross-month", roundLabel("2026-06-30", "2026-07-06") === "30 มิ.ย.–6 ก.ค.");
}

if (failed > 0) {
  console.error(`\nREVSHARE TESTS FAILED: ${failed}`);
  process.exit(1);
}
console.log("\nrevshare: all tests passed");
