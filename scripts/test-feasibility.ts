// Unit checks for the FEASIBILITY engine (src/lib/feasibility.ts).
// Run: node --import tsx scripts/test-feasibility.ts
//
// These assert the P&L math against hand-computed values + internal
// consistency. The spec's reference acceptance (HYPOPLARAEMIA → profit
// 99,393.73 / payback 23.24 / CMR 0.47) is pending the owner's actual
// HYPOPLARAEMIA input numbers and is checked separately once provided.

import {
  blankInputs, evaluate, computeScenario, startupTotal, fixedTotal, decide,
  type FeasibilityInputs
} from "../src/lib/feasibility";

let failed = 0;
function near(label: string, got: number, want: number, eps = 0.01) {
  if (Math.abs(got - want) > eps) {
    console.error(`✗ ${label}: got ${got}, want ${want}`);
    failed++;
  } else {
    console.log(`✓ ${label} = ${got}`);
  }
}
function eq(label: string, got: unknown, want: unknown) {
  if (got !== want) { console.error(`✗ ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); failed++; }
  else console.log(`✓ ${label} = ${JSON.stringify(got)}`);
}

// 1) Blank project → all zeros + "no" verdict (profit not > 0).
{
  const b = blankInputs();
  const r = evaluate(b);
  near("blank base sales", r.base.sales, 0);
  near("blank base profit", r.base.profit, 0);
  eq("blank verdict", r.decision.verdict, "no");
  eq("blank thresholds payback", b.thresholds.paybackMonths, 36);
}

// 2) Hand-computed sit-in-only case.
{
  const inp: FeasibilityInputs = blankInputs();
  inp.assumptions.seats = 10;
  inp.assumptions.occupancyPct = 100;
  inp.assumptions.avgCheckSitin = 100;
  inp.assumptions.cogsSitinPct = 30;
  inp.assumptions.weekdayDays = 20;
  inp.assumptions.weekendDays = 8;
  inp.assumptions.turnoverWeekday.base = 2;
  inp.assumptions.turnoverWeekend.base = 3;
  inp.variablePct.royalty = 5;       // varRate 0.05
  inp.fixed.rent = 10000;
  inp.startup.construction = 1_000_000;

  near("startupTotal", startupTotal(inp), 1_000_000);
  near("fixedTotal", fixedTotal(inp), 10208.3333, 0.01); // 10000 + 1e6/400/12

  const base = computeScenario(inp, "base");
  near("sales", base.sales, 64000);
  near("cogs", base.cogs, 19200);
  near("variable", base.variable, 3200);
  near("profit", base.profit, 31391.6667, 0.01);
  near("cmr", base.cmr, 0.65);
  near("breakevenBaht", base.breakevenBaht, 15705.128, 0.01);
  near("paybackMonths", base.paybackMonths, 31.855, 0.01);
  near("roiAnnual", base.roiAnnual, 0.37670, 0.0001);
  near("marginOfSafety", base.marginOfSafety, 0.75461, 0.0001);
}

// 3) Decision boundaries.
{
  const th = { paybackMonths: 36, roiPct: 20, mosPct: 20 };
  eq("loss → no", decide({ profit: -1 } as never, th).verdict, "no");
  eq("all pass → go",
    decide({ profit: 1, paybackMonths: 10, roiAnnual: 0.3, marginOfSafety: 0.3 } as never, th).verdict, "go");
  const slow = decide({ profit: 1, paybackMonths: 40, roiAnnual: 0.3, marginOfSafety: 0.3 } as never, th);
  eq("slow payback → caution", slow.verdict, "caution");
  eq("slow payback reason", slow.reasons.includes("คืนทุนช้ากว่าเป้า"), true);
}

if (failed > 0) { console.error(`\nFEASIBILITY engine: ${failed} check(s) FAILED`); process.exit(1); }
console.log("\nFEASIBILITY engine: all checks passed");
