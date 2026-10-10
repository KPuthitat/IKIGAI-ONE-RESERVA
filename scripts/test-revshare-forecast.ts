// Whole-month sales estimate for a revshare partner (owner 2026-10-06).
// Run:  node --import tsx scripts/test-revshare-forecast.ts

import { projectMonthSales, shopShareStats } from "../src/lib/revshare-forecast";

let passed = 0, failed = 0;
const ok = (n: string, c: boolean) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

// October 2026: Thu 1 … Sat 31. Closed Mondays. History: Sep 7 (Mon) … Oct 6.
// Every Tuesday = 1000, Wed = 2000, Thu = 3000, Fri = 4000, Sat = 5000, Sun = 6000.
const PER_DOW: Record<number, number> = { 2: 1000, 3: 2000, 4: 3000, 5: 4000, 6: 5000, 0: 6000 };
const history: Array<{ date: string; sales: number }> = [];
for (let d = new Date("2026-09-07T00:00:00Z"); d <= new Date("2026-10-06T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
  const k = d.getUTCDay();
  if (PER_DOW[k]) history.push({ date: d.toISOString().slice(0, 10), sales: PER_DOW[k] });
}
const f = projectMonthSales({ year: 2026, month: 10, history, closedWeekdays: [1] })!;

// Actual Oct 1–6: Thu 3000 + Fri 4000 + Sat 5000 + Sun 6000 + (Mon closed) + Tue 1000 = 19000.
ok("actual = sum of the imported days this month", near(f.actual, 19000) && f.actualDays === 5 && f.lastDate === "2026-10-06");
// Oct 7–31 (open days): Wed 7,14,21,28 = 4×2000; Thu 8,15,22,29 = 4×3000; Fri 9,16,23,30 = 4×4000;
// Sat 10,17,24,31 = 4×5000; Sun 11,18,25 = 3×6000; Tue 13,20,27 = 3×1000; Mondays skipped.
ok("remaining open days = 22 (Mondays skipped)", f.remainingDays === 22);
ok("remaining estimate uses each weekday's own average", near(f.remainingEstimate, 8000 + 12000 + 16000 + 20000 + 18000 + 3000));
ok("total = actual + estimate", near(f.total, 19000 + 77000));
ok("every weekday had history → weekday method", f.method === "weekday");

// A weekday with no history falls back to the overall mean.
const noSat = history.filter((h) => new Date(`${h.date}T00:00:00Z`).getUTCDay() !== 6);
const g = projectMonthSales({ year: 2026, month: 10, history: noSat, closedWeekdays: [1] })!;
ok("missing weekday → overall-mean fallback is flagged", g.method === "overall" && g.remainingEstimate > 0);

// Nothing left → no estimate days; no history → null.
const full = projectMonthSales({ year: 2026, month: 10, history: [...history, { date: "2026-10-31", sales: 5000 }], closedWeekdays: [1] })!;
ok("last day of the month imported → nothing remaining", full.remainingDays === 0 && near(full.total, full.actual));
ok("no sales history at all → null", projectMonthSales({ year: 2026, month: 10, history: [], closedWeekdays: [] }) === null);

// Month with no import yet still projects from the prior-weeks run rate.
const early = projectMonthSales({ year: 2026, month: 10, history: history.filter((h) => h.date < "2026-10-01"), closedWeekdays: [1] })!;
ok("no import yet this month → projects the whole month from history", early.actual === 0 && early.actualDays === 0 && early.lastDate === null && early.remainingDays === 27);

// Partner share of the whole restaurant.
const sh = shopShareStats({
  partnerDaily: [{ date: "2026-10-01", sales: 200 }, { date: "2026-10-02", sales: 300 }, { date: "2026-10-03", sales: 999 }],
  shopDaily: [{ date: "2026-10-01", sales: 1000 }, { date: "2026-10-02", sales: 1000 }],
  partnerForecastTotal: 1000, shopForecastTotal: 8000
});
ok("share: per day = partner ÷ restaurant", sh.perDay["2026-10-01"] === 20 && sh.perDay["2026-10-02"] === 30);
ok("share: a day only one side has is ignored", sh.perDay["2026-10-03"] === undefined && sh.cumulative?.days === 2);
ok("share: cumulative = Σ partner ÷ Σ restaurant (500 ÷ 2000 = 25%)", sh.cumulative?.pct === 25 && sh.cumulative?.partner === 500 && sh.cumulative?.shop === 2000);
ok("share: latest day and whole-month forecast (1000 ÷ 8000 = 12.5%)", sh.latest?.date === "2026-10-02" && sh.latest?.pct === 30 && sh.forecast?.pct === 12.5);
ok("share: no restaurant data → nothing", (() => { const e = shopShareStats({ partnerDaily: [{ date: "2026-10-01", sales: 5 }], shopDaily: [] }); return e.cumulative === null && e.latest === null && e.forecast === null; })());

console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
