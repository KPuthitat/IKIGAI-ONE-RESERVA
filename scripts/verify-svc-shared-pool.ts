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
  skipGroupInsurance: boolean; exempted?: boolean; yearMonth: string; whtRate: number;
}) {
  const gross = round2(input.grossRaw);
  const scheduledMinutes = input.realScheduledMinutes > 0 ? input.realScheduledMinutes : input.fallbackScheduled;
  const lateRatio = scheduledMinutes > 0 ? input.lateMinutes / scheduledMinutes : 0;
  const lateForfeit = input.anyComputable && lateRatio > SC_INELIGIBILITY_THRESHOLD;
  const wouldForfeit = lateForfeit || input.resignForfeit;
  const exempted = wouldForfeit && !!input.exempted;
  const forfeited = wouldForfeit && !exempted;
  const foodClawback = forfeited ? 0 : Math.min(round2(input.rawFoodClawback), gross);
  const netAllocation = forfeited ? 0 : round2(gross - foodClawback);
  const whtAmount = input.taxMode === "wht" ? round2(netAllocation * input.whtRate) : 0;
  const groupInsurance = input.skipGroupInsurance ? 0 : groupInsuranceDeduction({
    employmentType: input.giEmploymentType, startMonth: input.giStartMonth,
    yearMonth: input.yearMonth, availablePayout: round2(netAllocation - whtAmount)
  });
  const netPayout = round2(netAllocation - whtAmount - groupInsurance);
  return { gross, forfeited, exempted, foodClawback, netAllocation, whtAmount, groupInsurance, netPayout };
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

// ── executive forfeiture exemption (owner 2026-08-20) ────────────
// The automatic rule still fires, but an exec can WAIVE it for one person/month →
// forfeited flips to false and they are paid (WHT/GI still apply). The flag only
// matters when the person WOULD have been forfeited.
const exLate = rollup({ grossRaw: 500, lateMinutes: 2500, anyComputable: true,
  realScheduledMinutes: 9600, fallbackScheduled: 14400, resignForfeit: false,
  rawFoodClawback: 0, taxMode: "sso", giEmploymentType: "pt", giStartMonth: null,
  skipGroupInsurance: false, exempted: true, yearMonth: "2026-08", whtRate: 0.03 });
assert(!exLate.forfeited && exLate.exempted && exLate.netPayout === 500,
  "exempt a late-20% forfeiture → paid full 500");

const exResign = rollup({ grossRaw: 300, lateMinutes: 0, anyComputable: false,
  realScheduledMinutes: 0, fallbackScheduled: 14400, resignForfeit: true,
  rawFoodClawback: 0, taxMode: "wht", giEmploymentType: "pt", giStartMonth: null,
  skipGroupInsurance: false, exempted: true, yearMonth: "2026-08", whtRate: 0.03 });
assert(!exResign.forfeited && exResign.exempted && exResign.whtAmount === 9 && exResign.netPayout === 291,
  "exempt a resignation forfeiture → paid, WHT still applies (300−9=291)");

const exNoop = rollup({ grossRaw: 240, lateMinutes: 0, anyComputable: true,
  realScheduledMinutes: 9600, fallbackScheduled: 14400, resignForfeit: false,
  rawFoodClawback: 0, taxMode: "sso", giEmploymentType: "pt", giStartMonth: null,
  skipGroupInsurance: false, exempted: true, yearMonth: "2026-08", whtRate: 0.03 });
assert(!exNoop.forfeited && !exNoop.exempted && exNoop.netPayout === 240,
  "exemption on a NON-forfeited person is a no-op (exempted=false, still paid 240)");

// ── คำนวณรวมทั้งบริษัท: amount-branch workers get ONLY their branch; only workers
// sent to a NO-amount branch are folded into the amount pools (owner 2026-08-20) ──
// Mirrors computeCompanySvcSummaryShared's day loop. "orphan" = a company member
// whose branch had no amount that day; a cross-company visitor at a no-amount
// branch is dropped (gets only their own branch, i.e. nothing).
type Worker = { id: string; branch: string; min: number; member: boolean };
function distributeDay(amountByBranch: Record<string, number>, workers: Worker[]) {
  const out: Record<string, number> = {};
  const add = (id: string, s: number) => { out[id] = (out[id] ?? 0) + s; };
  let undistributed = 0;   // no-worker amount branch → company retains
  const amountBranches = Object.keys(amountByBranch).filter((b) => amountByBranch[b] > 0);
  const orphans = workers.filter((w) => w.member && !(amountByBranch[w.branch] > 0));
  const orphanMin = orphans.reduce((s, w) => s + w.min, 0);
  for (const b of amountBranches) {
    const placed = workers.filter((w) => w.branch === b);
    const placedMin = placed.reduce((s, w) => s + w.min, 0);
    const divisor = placedMin > 0 ? placedMin + orphanMin : 0;
    const staffPoolB = amountByBranch[b] * SVC_STAFF_SHARE_RATIO;
    if (divisor <= 0) { undistributed += staffPoolB; continue; }
    for (const w of placed) add(w.id, staffPoolB * (w.min / divisor));
    for (const w of orphans) add(w.id, staffPoolB * (w.min / divisor));  // orphan floats in
  }
  return { out, undistributed };
}

// Scenario A: HYPO has NO amount. NAMA pool 600. A,B at NAMA; ทิพวรรณ (member) sent
// to HYPO → orphan, folded into NAMA; Sala-Chill (cross-company) at HYPO → 0.
const { out: dayA } = distributeDay(
  { NAMA: 1000, HYPO: 0 },
  [
    { id: "A", branch: "NAMA", min: 480, member: true },
    { id: "B", branch: "NAMA", min: 480, member: true },
    { id: "TIP", branch: "HYPO", min: 480, member: true },
    { id: "SALA", branch: "HYPO", min: 480, member: false }
  ]
);
assert(near(dayA["TIP"], 200), `orphan ทิพวรรณ (no-amount HYPO) folded into NAMA pool = 200 (got ${dayA["TIP"]})`);
assert(near(dayA["A"], 200) && near(dayA["B"], 200), "NAMA workers diluted only by the orphan = 200 each");
assert((dayA["SALA"] ?? 0) === 0, "cross-company visitor at no-amount branch gets 0");
assert(near((dayA["A"] ?? 0) + (dayA["B"] ?? 0) + (dayA["TIP"] ?? 0), 600), "day A reconciles to 600");

// Scenario B (THE fix): both NAMA=1000 & HYPO=500 have amounts. A NAMA worker must
// get ONLY NAMA's pool — never a slice of HYPO's amount.
const { out: dayB } = distributeDay(
  { NAMA: 1000, HYPO: 500 },
  [
    { id: "A", branch: "NAMA", min: 480, member: true },
    { id: "B", branch: "NAMA", min: 480, member: true },
    { id: "C", branch: "HYPO", min: 480, member: true },
    { id: "SALA", branch: "HYPO", min: 480, member: false }
  ]
);
assert(near(dayB["A"], 300) && near(dayB["B"], 300), `NAMA workers get ONLY NAMA (300 each), NOT HYPO's money (got A=${dayB["A"]})`);
assert(near(dayB["C"], 150) && near(dayB["SALA"], 150), "HYPO's 300 pool split by its own workers = 150 each (incl cross-company)");
assert(near(dayB["A"] + dayB["B"] + dayB["C"] + dayB["SALA"], 900), "day B reconciles to 900");

// Scenario C: orphan sent to a THIRD no-amount branch floats across BOTH amount pools.
const { out: dayC } = distributeDay(
  { NAMA: 1000, HYPO: 500, SALAB: 0 },
  [
    { id: "A", branch: "NAMA", min: 480, member: true },
    { id: "C", branch: "HYPO", min: 480, member: true },
    { id: "TIP", branch: "SALAB", min: 480, member: true }
  ]
);
assert(near(dayC["A"], 300), `A (NAMA) = 300 (got ${dayC["A"]})`);
assert(near(dayC["C"], 150), `C (HYPO) = 150 (got ${dayC["C"]})`);
assert(near(dayC["TIP"], 450), `orphan draws from BOTH amount branches = 300+150 = 450 (got ${dayC["TIP"]})`);
assert(near(dayC["A"] + dayC["C"] + dayC["TIP"], 900), "day C reconciles to 900");

// Scenario D: HYPO=500 recorded but no HYPO worker and no orphan → HYPO's share is
// NOT leaked to the NAMA worker (company retains it). A gets ONLY NAMA's 600.
const rD = distributeDay(
  { NAMA: 1000, HYPO: 500 },
  [{ id: "A", branch: "NAMA", min: 480, member: true }]
);
assert(near(rD.out["A"], 600), `A gets ONLY NAMA's 600 — HYPO's 300 does not leak (got ${rD.out["A"]})`);
assert(near(rD.undistributed, 300), `HYPO's 300 (no worker) retained by company (got ${rD.undistributed})`);

// Scenario E (the review fix): HYPO=500 has no worker, but an UNRELATED orphan TIP
// works a third no-amount branch SALAB. HYPO's 300 must still be company-retained —
// NOT handed to TIP who never worked HYPO. TIP draws only from NAMA.
const rE = distributeDay(
  { NAMA: 1000, HYPO: 500, SALAB: 0 },
  [
    { id: "A", branch: "NAMA", min: 480, member: true },
    { id: "TIP", branch: "SALAB", min: 480, member: true }
  ]
);
assert(near(rE.out["A"], 300) && near(rE.out["TIP"], 300),
  `NAMA pool (600) split A+TIP = 300 each (got A=${rE.out["A"]}, TIP=${rE.out["TIP"]})`);
assert(near(rE.undistributed, 300),
  "no-worker HYPO 300 stays company-retained even with an unrelated orphan present");

// ── ACCOUNTA per-branch payout split (owner 2026-08-20) ──────────
// In combined mode a person's net/WHT/GI is split across the branches they earned
// at, in proportion to gross — so a ฿1000 NAMA + ฿500 HYPO earner books 2:1, and
// the sum across branches equals their total. Mirrors computeBranchSvcPayout.
// Cumulative (prefix-sum) rounding — mirrors computeBranchSvcPayout so the split
// across branches reconciles EXACTLY to the total (no satang drift).
function splitByBranch(
  byBranch: Array<{ branch: string; gross: number }>, net: number, wht: number, gins: number
) {
  const totalGross = byBranch.reduce((s, b) => s + b.gross, 0);
  const out: Array<{ branch: string; net: number; wht: number; gins: number }> = [];
  let prior = 0;
  for (const b of byBranch) {
    const alloc = (v: number) =>
      round2(v * (prior + b.gross) / totalGross) - round2(v * prior / totalGross);
    out.push({ branch: b.branch, net: alloc(net), wht: alloc(wht), gins: alloc(gins) });
    prior += b.gross;
  }
  return out;
}
const split = splitByBranch([{ branch: "NAMA", gross: 1000 }, { branch: "HYPO", gross: 500 }], 1455, 45, 0);
assert(near(split[0].net, 970) && near(split[1].net, 485), `net split 2:1 → NAMA 970 / HYPO 485 (got ${split[0].net}/${split[1].net})`);
assert(near(split[0].net + split[1].net, 1455), "branch net sums to the person's total net");
assert(near(split[0].wht, 30) && near(split[1].wht, 15), "WHT split 2:1 → 30 / 15");

// Even 3-way split of 100.00 must reconcile to EXACTLY 100.00 (33.33/33.33/33.34),
// which naïve independent rounding (33.33×3 = 99.99) would miss.
const split3 = splitByBranch(
  [{ branch: "A", gross: 100 }, { branch: "B", gross: 100 }, { branch: "C", gross: 100 }], 100, 0, 350);
assert(near(split3.reduce((s, b) => s + b.net, 0), 100), `3-way net reconciles to exactly 100 (got ${split3.map((b) => b.net).join("+")})`);
assert(near(split3.reduce((s, b) => s + b.gins, 0), 350), "3-way group-insurance reconciles to exactly 350");

console.log("\nALL SHARED-POOL SVC FIXTURES PASSED");
