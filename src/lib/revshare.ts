// Revenue-Share GP — core calculation (pure, client-safe, the single source of
// truth). Settlement page, statement, and API all call THESE functions; never
// re-derive the math elsewhere. Owner 2026-06-22 (HYPOPLARAEMIA × Groggy).
//
// Money is reckoned in full precision; round2 is applied only at the values we
// store/display. GP is a progressive (marginal) split on the WHOLE-MONTH sales,
// like income tax — each tier rate applies only to the slice inside that tier,
// so there's no "cliff" at a boundary.

export type Tier = { lower: number; upper: number | null; rate: number };
export type Floor = { monthFrom: number; monthTo: number; amount: number };
export type SalesBase = "gross" | "after_discount" | "nett";

/** Half-up round to 2 dp (money). +1e-9 nudges past float artefacts like
 *  x*100 = 4619.9999999. */
export function round2(x: number): number {
  return Math.round((x + (x >= 0 ? 1e-9 : -1e-9)) * 100) / 100;
}

/** Progressive (marginal) GP on a month's total sales. Each tier contributes
 *  rate × (the part of `sales` that falls inside [lower, upper]). NOT rounded —
 *  callers round at the boundary. */
export function marginalGP(sales: number, tiers: Tier[]): number {
  let gp = 0;
  for (const t of tiers) {
    if (sales <= t.lower) break;
    const upper = t.upper ?? Infinity;
    gp += (Math.min(sales, upper) - t.lower) * t.rate;
  }
  return gp;
}

/** The minimum-billing floor for a given contract month (1-indexed). Returns 0
 *  when no floor row covers the month (e.g. month 7+). */
export function floorFor(opMonth: number, floors: Floor[]): number {
  for (const f of floors) {
    if (opMonth >= f.monthFrom && opMonth <= f.monthTo) return f.amount;
  }
  return 0;
}

/** Contract month number (1-indexed) of the settled month, counting from the
 *  partner's start_date. start 2026-01-xx, settle 2026-01 → 1; 2026-02 → 2. */
export function opMonthFor(startDate: string, settleYear: number, settleMonth: number): number {
  const [sy, sm] = startDate.split("-").map(Number);
  return (settleYear - sy) * 12 + (settleMonth - sm) + 1;
}

export type RoundBreakdownRow = {
  sales: number;        // this round's sales
  cumSales: number;     // cumulative sales up to and including this round
  roundGP: number;      // marginalGP(cum) − marginalGP(prevCum) — rounded
  gpPct: number;        // roundGP / sales (0 when sales = 0)
};

/** GP attributed to each round via cumulative-difference, so the rounds sum
 *  back to marginalGP(total) exactly (reconcilable). Input = each round's sales
 *  in chronological order. */
export function computeRoundBreakdown(roundSales: number[], tiers: Tier[]): RoundBreakdownRow[] {
  const out: RoundBreakdownRow[] = [];
  let cum = 0;
  let prevGp = 0;
  for (const sales of roundSales) {
    cum += sales;
    const gpAtCum = marginalGP(cum, tiers);
    const roundGP = round2(gpAtCum - prevGp);
    out.push({
      sales: round2(sales),
      cumSales: round2(cum),
      roundGP,
      gpPct: sales > 0 ? roundGP / sales : 0
    });
    prevGp = gpAtCum;
  }
  return out;
}

export type SettlementInput = {
  totalSales: number;
  opMonth: number;
  tiers: Tier[];
  floors: Floor[];
  vatEnabled: boolean;
  vatRate: number;   // e.g. 0.07
  whtRate: number;   // e.g. 0.03
};

export type SettlementResult = {
  totalSales: number;
  tierGP: number;        // progressive GP on total sales
  floorApplied: number;  // the floor for this op month (0 if none)
  billedGP: number;      // max(tierGP, floor)
  topup: number;         // billedGP − tierGP (the minimum top-up)
  avgGpPct: number;      // tierGP / totalSales (0 when no sales)
  vatAmount: number;     // output VAT on billedGP (0 when disabled)
  whtAmount: number;     // WHT on billedGP (base = GP before VAT)
  netAmount: number;     // billedGP + VAT − WHT (what the partner nets out)
};

/** Monthly settlement. VAT (output) and WHT both sit on the billed GP (WHT base
 *  is GP BEFORE vat — the two don't compound). */
export function computeSettlement(inp: SettlementInput): SettlementResult {
  const totalSales = round2(Math.max(0, inp.totalSales));
  const tierGP = round2(marginalGP(totalSales, inp.tiers));
  const floorApplied = round2(floorFor(inp.opMonth, inp.floors));
  const billedGP = Math.max(tierGP, floorApplied);
  const topup = round2(Math.max(0, billedGP - tierGP));
  const avgGpPct = totalSales > 0 ? tierGP / totalSales : 0;
  const vatAmount = inp.vatEnabled ? round2(billedGP * inp.vatRate) : 0;
  const whtAmount = round2(billedGP * inp.whtRate);
  const netAmount = round2(billedGP + vatAmount - whtAmount);
  return {
    totalSales, tierGP, floorApplied, billedGP: round2(billedGP), topup,
    avgGpPct, vatAmount, whtAmount, netAmount
  };
}

// ── Default template (the Groggy case) — used to prefill a NEW partner's tiers
//    & floors. Everything is editable per partner afterwards; nothing here is
//    hardcoded into the calc. ───────────────────────────────────────────────

export const DEFAULT_TIERS: Tier[] = [
  { lower: 0, upper: 200_000, rate: 0.18 },
  { lower: 200_000, upper: 350_000, rate: 0.15 },
  { lower: 350_000, upper: 500_000, rate: 0.15 },
  { lower: 500_000, upper: 1_000_000, rate: 0.10 },
  { lower: 1_000_000, upper: null, rate: 0.10 }
];

export const DEFAULT_FLOORS: Floor[] = [
  { monthFrom: 1, monthTo: 2, amount: 15_000 },
  { monthFrom: 3, monthTo: 4, amount: 18_000 },
  { monthFrom: 5, monthTo: 6, amount: 20_000 }
];

// ── Thai date helpers (พ.ศ.) — small + local; the codebase has no shared one. ─

export const TH_MONTHS_FULL = [
  "", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
];
export const TH_MONTHS_ABBR = [
  "", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."
];

/** "2026-06-15" → "15 มิถุนายน 2569". */
export function thaiDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${TH_MONTHS_FULL[m]} ${y + 543}`;
}

/** A compact label for a round's date span, e.g. "15–21 มิ.ย." (same month) or
 *  "30 มิ.ย.–6 ก.ค." (spanning two months). */
export function roundLabel(startIso: string, endIso: string): string {
  const [, sm, sd] = startIso.split("-").map(Number);
  const [, em, ed] = endIso.split("-").map(Number);
  if (sm === em) return `${sd}–${ed} ${TH_MONTHS_ABBR[sm]}`;
  return `${sd} ${TH_MONTHS_ABBR[sm]}–${ed} ${TH_MONTHS_ABBR[em]}`;
}
