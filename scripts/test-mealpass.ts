// Unit tests for the MEALPASS 2.0 earn/burn engine. Run: npm run test:mealpass
// Money-critical PURE logic only (no DB) — mirrors test-group-insurance.
import {
  classifyShift, creditsForShift, applyMonthlyCap, burnQuote, resolveMealCharge, ymOf,
  DEFAULT_FULL_CREDITS, DEFAULT_HALF_CREDITS,
} from "../src/lib/mealpass";

let failed = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.error(`✗ ${name}: got ${g}, want ${w}`); failed++; }
  else console.log(`✓ ${name} = ${g}`);
}

const cfg = { full_day_credits: DEFAULT_FULL_CREDITS, half_day_credits: DEFAULT_HALF_CREDITS };
const rates = { special_rate: 0.5, cash_discount: 0.10 };

// ── classifyShift ──
eq("full: 8h rostered, worked ≥450", classifyShift(480, 450), "full");
eq("full: worked exactly floor", classifyShift(480, 450), "full");
eq("half: full roster but worked <450 (left early)", classifyShift(480, 449), "half");
eq("half: 4h rostered, worked ≥210", classifyShift(240, 210), "half");
eq("none: 4h rostered, worked <210", classifyShift(240, 209), "none");
eq("none: rostered <4h", classifyShift(239, 239), "none");
eq("none: no shift", classifyShift(0, 0), "none");
eq("full: long shift", classifyShift(600, 560), "full");

// ── creditsForShift ──
eq("credits full = 60", creditsForShift(480, 460, cfg), 60);
eq("credits half = 30", creditsForShift(240, 220, cfg), 30);
eq("credits none = 0", creditsForShift(120, 120, cfg), 0);

// ── applyMonthlyCap (cap 1500) ──
eq("cap: room for full", applyMonthlyCap(1440, 60, 1500), 60);
eq("cap: partial room", applyMonthlyCap(1470, 60, 1500), 30);
eq("cap: exactly full", applyMonthlyCap(1500, 60, 1500), 0);
eq("cap: 10 left", applyMonthlyCap(1490, 60, 1500), 10);
eq("cap: already over → 0 (never negative)", applyMonthlyCap(1520, 60, 1500), 0);

// ── burnQuote ──
eq("burn standard = 60 credits", burnQuote({ mealClass: "standard", creditCost: 60, price: 120, cfg: rates }),
  { mealClass: "standard", credits: 60, baht: 0 });
eq("burn special = 50% of price in credits", burnQuote({ mealClass: "special", creditCost: 60, price: 200, cfg: rates }),
  { mealClass: "special", credits: 100, baht: 0 });
eq("burn cash = price −10%", burnQuote({ mealClass: "cash", creditCost: 60, price: 200, cfg: rates }),
  { mealClass: "cash", credits: 0, baht: 180 });

// ── resolveMealCharge (balance-aware) ──
eq("standard, enough balance → 60 credits",
  resolveMealCharge({ isStandard: true, creditCost: 60, price: 120, balance: 100, cfg: rates }),
  { mealClass: "standard", credits: 60, baht: 0 });
eq("standard, short balance → cash −10%",
  resolveMealCharge({ isStandard: true, creditCost: 60, price: 120, balance: 50, cfg: rates }),
  { mealClass: "cash", credits: 0, baht: 108 });
eq("special, enough balance → 50% credits",
  resolveMealCharge({ isStandard: false, creditCost: 60, price: 200, balance: 100, cfg: rates }),
  { mealClass: "special", credits: 100, baht: 0 });
eq("special, short balance → cash −10%",
  resolveMealCharge({ isStandard: false, creditCost: 60, price: 200, balance: 99, cfg: rates }),
  { mealClass: "cash", credits: 0, baht: 180 });

// ── ymOf ──
eq("ymOf slices to YYYY-MM", ymOf("2026-08-09"), "2026-08");

if (failed > 0) { console.error(`\n${failed} test(s) failed`); process.exit(1); }
console.log(`\nAll MEALPASS engine tests passed`);
