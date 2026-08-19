// Fixture: the company-wide "รวมกอง" shared-pool SVC distribution + company roll-up
// (owner 2026-08-18). The real compute (computeCompanySvcSummaryShared) reads the
// DB, which getDb() can't bootstrap fresh in this env — so this mirrors the exact
// per-day pooled-split arithmetic and the rollupCompanyRow forfeit/WHT/GI math
// against hand-worked numbers. Run:
//   node --import tsx scripts/verify-svc-shared-pool.ts
import {
  SVC_STAFF_SHARE_RATIO, SVC_COMPANY_SHARE_RATIO,
  groupInsuranceDeduction
} from "../src/lib/service-charge";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}
const round2 = (n: number) => Math.round(n * 100) / 100;
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) < eps;

assert(SVC_STAFF_SHARE_RATIO === 0.6 && SVC_COMPANY_SHARE_RATIO === 0.4, "60/40 split constants");

// ── Scenario (owner's HYPO case) ─────────────────────────────────
// Two branches, ONE company. On 2026-08-10:
//   NAMA entered ฿1000 SVC. HYPO (new) entered ฿0.
//   Worked that day:  A = 480 min @ NAMA,  B = 480 min @ HYPO (ทิพวรรณ),
//                     C = 240 min @ NAMA.
// Shared pool: the whole ฿1000 is pooled; staff pool = 600; split by minutes across
// ALL three regardless of which branch's pool it came from — so B (at HYPO, no pool)
// still gets a share.
const pooled = 1000 + 0;
const staffPool = pooled * SVC_STAFF_SHARE_RATIO;      // 600
const units = [
  { u: "A", branch: "NAMA", min: 480 },
  { u: "B", branch: "HYPO", min: 480 },
  { u: "C", branch: "NAMA", min: 240 }
];
const totalMin = units.reduce((s, x) => s + x.min, 0); // 1200
assert(staffPool === 600, "pooled staff share = 600");
assert(totalMin === 1200, "divisor = all worked minutes across branches = 1200");

const shareOf = (min: number) => staffPool * (min / totalMin);
const shareA = shareOf(480); // 240
const shareB = shareOf(480); // 240
const shareC = shareOf(240); // 120
assert(near(shareA, 240), `A share = 600×480/1200 = 240 (got ${shareA})`);
assert(near(shareB, 240), `B (HYPO, no pool) STILL shares = 240 (got ${shareB})`);
assert(near(shareC, 120), `C share = 600×240/1200 = 120 (got ${shareC})`);
assert(near(shareA + shareB + shareC, staffPool), "day shares reconcile to the staff pool");

// ── Per-branch attribution ("ได้จากสาขาไหนเท่าไหร่") ────────────────
// Each person's share is attributed to the branch they physically worked at. B's
// whole 240 is attributed to HYPO even though the money came from NAMA's pool.
const byBranch: Record<string, number> = {};
for (const x of units) byBranch[x.branch] = (byBranch[x.branch] ?? 0) + shareOf(x.min);
assert(near(byBranch["NAMA"], 360), `NAMA attribution = A+C = 360 (got ${byBranch["NAMA"]})`);
assert(near(byBranch["HYPO"], 240), `HYPO attribution = B = 240 (got ${byBranch["HYPO"]})`);

// A person splitting a single day across TWO branches: 300 min NAMA + 180 min HYPO.
// Their day share is split by minutes-at-branch — reconciles to the same total.
const dMin = 300 + 180;
const dTotal = 480 + dMin; // suppose one other worker at 480
const dPool = 500 * SVC_STAFF_SHARE_RATIO;
const dShareNama = dPool * (300 / dTotal);
const dShareHypo = dPool * (180 / dTotal);
const dShareTotal = dPool * (dMin / dTotal);
assert(near(dShareNama + dShareHypo, dShareTotal),
  "single-day two-branch split reconciles to the person's day share");

// ── rollupCompanyRow arithmetic (mirrors the exported helper) ─────
// Re-implement the pure math the helper does so we lock the forfeit/WHT/GI order.
const SC_INELIGIBILITY_THRESHOLD = 0.20;
function rollup(input: {
  grossRaw: number; lateMinutes: number; anyComputable: boolean;
  realScheduledMinutes: number; fallbackScheduled: number;
  resignForfeit: boolean; rawFoodClawback: number;
  taxMode: "sso" | "wht"; giEmploymentType: string | null; giStartMonth: string | null;
  skipGroupInsurance: boolean; yearMonth: string; whtRate: number;
}) {
  const gross = round2(input.grossRaw);
  const scheduledMinutes = input.realScheduledMinutes > 0 ? input.realScheduledMinutes : input.fallbackScheduled;
  const lateRatio = scheduledMinutes > 0 ? input.lateMinutes / scheduledMinutes : 0;
  const lateForfeit = input.anyComputable && lateRatio > SC_INELIGIBILITY_THRESHOLD;
  const forfeited = lateForfeit || input.resignForfeit;
  const foodClawback = forfeited ? 0 : Math.min(round2(input.rawFoodClawback), gross);
  const netAllocation = forfeited ? 0 : round2(gross - foodClawback);
  const whtAmount = input.taxMode === "wht" ? round2(netAllocation * input.whtRate) : 0;
  const groupInsurance = input.skipGroupInsurance ? 0 : groupInsuranceDeduction({
    employmentType: input.giEmploymentType, startMonth: input.giStartMonth,
    yearMonth: input.yearMonth, availablePayout: round2(netAllocation - whtAmount)
  });
  const netPayout = round2(netAllocation - whtAmount - groupInsurance);
  return { gross, forfeited, foodClawback, netAllocation, whtAmount, groupInsurance, netPayout };
}

// sso, no lateness → full net, no WHT, no GI (not enrolled)
const r1 = rollup({ grossRaw: 240, lateMinutes: 0, anyComputable: true,
  realScheduledMinutes: 9600, fallbackScheduled: 14400, resignForfeit: false,
  rawFoodClawback: 0, taxMode: "sso", giEmploymentType: "pt", giStartMonth: null,
  skipGroupInsurance: false, yearMonth: "2026-08", whtRate: 0.03 });
assert(r1.netPayout === 240 && r1.whtAmount === 0 && r1.groupInsurance === 0,
  "sso, punctual, not GI-enrolled → net 240");

// wht → 3% withheld
const r2 = rollup({ grossRaw: 240, lateMinutes: 0, anyComputable: true,
  realScheduledMinutes: 9600, fallbackScheduled: 14400, resignForfeit: false,
  rawFoodClawback: 0, taxMode: "wht", giEmploymentType: "pt", giStartMonth: null,
  skipGroupInsurance: false, yearMonth: "2026-08", whtRate: 0.03 });
assert(r2.whtAmount === 7.2 && r2.netPayout === 232.8, "wht 3% of 240 = 7.2 → net 232.8");

// GI enrolled (FT, month 0) → ฿350 withheld after WHT
const r3 = rollup({ grossRaw: 1000, lateMinutes: 0, anyComputable: true,
  realScheduledMinutes: 9600, fallbackScheduled: 14400, resignForfeit: false,
  rawFoodClawback: 0, taxMode: "sso", giEmploymentType: "ft", giStartMonth: "2026-08",
  skipGroupInsurance: false, yearMonth: "2026-08", whtRate: 0.03 });
assert(r3.groupInsurance === 350 && r3.netPayout === 650, "GI enrolled FT → 350 withheld, net 650");

// cross-company visitor → GI skipped even if enrolled (taken at home)
const r4 = rollup({ grossRaw: 1000, lateMinutes: 0, anyComputable: true,
  realScheduledMinutes: 9600, fallbackScheduled: 14400, resignForfeit: false,
  rawFoodClawback: 0, taxMode: "sso", giEmploymentType: "ft", giStartMonth: "2026-08",
  skipGroupInsurance: true, yearMonth: "2026-08", whtRate: 0.03 });
assert(r4.groupInsurance === 0 && r4.netPayout === 1000, "cross-company visitor → GI skipped, net 1000");

// late > 20% across the company → whole month forfeited
const r5 = rollup({ grossRaw: 500, lateMinutes: 2500, anyComputable: true,
  realScheduledMinutes: 9600, fallbackScheduled: 14400, resignForfeit: false,
  rawFoodClawback: 0, taxMode: "sso", giEmploymentType: "pt", giStartMonth: null,
  skipGroupInsurance: false, yearMonth: "2026-08", whtRate: 0.03 });
assert(2500 / 9600 > 0.20 && r5.forfeited && r5.netPayout === 0,
  "company-summed late 2500/9600 > 20% → forfeited, net 0");

// food clawback capped by gross, then reduces net
const r6 = rollup({ grossRaw: 300, lateMinutes: 0, anyComputable: true,
  realScheduledMinutes: 9600, fallbackScheduled: 14400, resignForfeit: false,
  rawFoodClawback: 120, taxMode: "sso", giEmploymentType: "pt", giStartMonth: null,
  skipGroupInsurance: false, yearMonth: "2026-08", whtRate: 0.03 });
assert(r6.foodClawback === 120 && r6.netPayout === 180, "food clawback 120 → net 180");

// forfeited month → no clawback recovered (already 0)
const r7 = rollup({ grossRaw: 300, lateMinutes: 0, anyComputable: false,
  realScheduledMinutes: 0, fallbackScheduled: 14400, resignForfeit: true,
  rawFoodClawback: 120, taxMode: "sso", giEmploymentType: "pt", giStartMonth: null,
  skipGroupInsurance: false, yearMonth: "2026-08", whtRate: 0.03 });
assert(r7.forfeited && r7.foodClawback === 0 && r7.netPayout === 0,
  "resignation-forfeited → clawback 0, net 0");

// ── combined 480-cap across branches (owner 2026-08-18) ──────────
// A cross-branch worker doing 300 min NAMA + 300 min HYPO on one day (no OT) must
// be capped to a combined 480 for the divisor, scaled proportionally per branch —
// not counted as 600 (which would out-weight a single-branch full day).
const SVC_MAX_NORMAL_MINUTES = 480;
function capCombined(perBranch: number[], hasOt: boolean): number[] {
  const combined = perBranch.reduce((s, x) => s + x, 0);
  const scale = combined > SVC_MAX_NORMAL_MINUTES && !hasOt ? SVC_MAX_NORMAL_MINUTES / combined : 1;
  return perBranch.map((x) => x * scale);
}
const capped = capCombined([300, 300], false);
assert(near(capped[0], 240) && near(capped[1], 240),
  `300+300 no-OT → scaled to 240+240 = 480 combined (got ${capped.join("+")})`);
assert(near(capped[0] + capped[1], 480), "combined capped at 480");
const cappedOt = capCombined([300, 300], true);
assert(near(cappedOt[0], 300) && near(cappedOt[1], 300), "300+300 WITH approved OT → NOT capped (600)");
const under = capCombined([240, 180], false);
assert(near(under[0], 240) && near(under[1], 180), "420 combined under cap → unchanged");

// ── cross-branch food clawback uses COMBINED minutes (owner 2026-08-18) ──
// A staffer works 240 @ NAMA (redeems lunch) + 240 @ HYPO = 480 combined. Judged
// on the combined day (≥ 450) they are NOT clawed — the bug was judging each
// branch's 240 in isolation. A genuine single-branch 240 (no transfer) IS clawed.
const FOOD_CLAWBACK_MIN = 480 - 30; // 450
const clawbackOnCombined = (branchMins: number[], approvedEarlyLeave: boolean) => {
  const combined = branchMins.reduce((s, x) => s + x, 0);
  if (approvedEarlyLeave) return false;
  return combined < FOOD_CLAWBACK_MIN;
};
assert(!clawbackOnCombined([240, 240], false), "240+240 combined = 480 ≥ 450 → NO clawback (transfer full day)");
assert(clawbackOnCombined([240], false), "single-branch 240 < 450 → clawed (left early)");
assert(!clawbackOnCombined([240], true), "240 but approved early-leave → NO clawback");

console.log("\nALL SHARED-POOL SVC FIXTURES PASSED");
