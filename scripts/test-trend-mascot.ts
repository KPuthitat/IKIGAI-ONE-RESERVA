// Mascot mood for a period-over-period change. Run: node --import tsx scripts/test-trend-mascot.ts
import { trendPose, TREND_FLAT_BAND } from "../src/app/components/TrendMascot";
import { clinicaMonthMoodPct } from "../src/lib/clinica-shared";
let failed = 0;
const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
ok("up beyond the band → thumbs", trendPose(TREND_FLAT_BAND) === "thumbs" && trendPose(35.5) === "thumbs");
ok("down beyond the band → glum", trendPose(-TREND_FLAT_BAND) === "shock" && trendPose(-60) === "shock");
ok("inside the band → hands on hips", trendPose(0) === "proud" && trendPose(1.99) === "proud" && trendPose(-1.99) === "proud");
ok("no comparison data → no mascot", trendPose(null) === null && trendPose(undefined) === null && trendPose(NaN) === null && trendPose(Infinity) === null);

// clinic month headline: current month uses the run-rate, not the part-month MoM figure
const m = { year: 2026, month: 10, billNet: 90_000, prevBillNet: 300_000, billNetMomPct: -70 };
const early = clinicaMonthMoodPct(m, "2026-10-10");   // 90k in 10 days → 279k projected vs 300k
ok("current month: run-rate projection (≈ -6.9%), not the raw -70%", early != null && Math.abs(early - ((279_000 - 300_000) / 300_000) * 100) < 1e-6);
ok("current month on a strong pace reads as up", (clinicaMonthMoodPct({ ...m, billNet: 150_000 }, "2026-10-10") ?? 0) > TREND_FLAT_BAND);
ok("finished month uses the printed MoM", clinicaMonthMoodPct({ ...m, billNetMomPct: 12.5 }, "2026-11-03") === 12.5);
ok("future month and missing baseline give no mood", clinicaMonthMoodPct(m, "2026-09-30") === null && clinicaMonthMoodPct({ ...m, prevBillNet: null }, "2026-10-10") === null);
process.exit(failed ? 1 : 0);
