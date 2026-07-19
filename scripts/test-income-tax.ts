// Unit tests for the SME corporate income-tax calc. Run: npm run test:income-tax
// Brackets: 0–300k = 0% · 300k–3M = 15% · >3M = 20% (progressive).
import { smeIncomeTax } from "../src/lib/income-tax";

let failed = 0;
function eq(name: string, got: number, want: number, tol = 0.005): void {
  if (Math.abs(got - want) > tol) { console.error(`✗ ${name}: got ${got}, want ${want}`); failed++; }
  else console.log(`✓ ${name} = ${got}`);
}
function ok(name: string, cond: boolean): void {
  if (!cond) { console.error(`✗ ${name}`); failed++; } else console.log(`✓ ${name}`);
}

// 1) zero / loss → no tax
eq("0 profit", smeIncomeTax(0).tax, 0);
eq("loss -500k", smeIncomeTax(-500_000).tax, 0);
ok("loss clamps netProfit to 0", smeIncomeTax(-500_000).netProfit === 0);
ok("loss has no brackets", smeIncomeTax(-500_000).brackets.length === 0);

// 2) exactly at the first threshold → still 0
eq("300k profit", smeIncomeTax(300_000).tax, 0);

// 3) inside the 15% band: 1,000,000 → (1,000,000-300,000)*15% = 105,000
eq("1M profit", smeIncomeTax(1_000_000).tax, 105_000);
{
  const r = smeIncomeTax(1_000_000);
  ok("1M uses 2 brackets (0% + 15%)", r.brackets.length === 2);
  eq("1M 15%-band taxable", r.brackets[1].taxable, 700_000);
}

// 4) exactly at the second threshold: 3,000,000 → 2,700,000*15% = 405,000
eq("3M profit", smeIncomeTax(3_000_000).tax, 405_000);

// 5) into the 20% band: 5,000,000 → 405,000 + (5,000,000-3,000,000)*20% = 405,000 + 400,000
eq("5M profit", smeIncomeTax(5_000_000).tax, 805_000);
{
  const r = smeIncomeTax(5_000_000);
  ok("5M uses 3 brackets", r.brackets.length === 3);
  eq("5M top-band tax", r.brackets[2].tax, 400_000);
  eq("5M effectiveRate%", r.effectiveRate * 100, 16.1, 0.05); // 805,000 / 5,000,000
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
