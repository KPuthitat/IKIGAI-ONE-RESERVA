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

/** Split a VAT-INCLUSIVE amount (retail sales already carry VAT) into its base
 *  and VAT parts. Used by the daily/weekly sales notifications — both parties
 *  are VAT-registered so the transfer carries the partner's output VAT (owner
 *  2026-06-23). GP (a service fee) adds VAT on top instead — see computeSettlement. */
export function vatInclusive(amount: number, rate = 0.07): { base: number; vat: number; total: number } {
  const total = round2(Math.max(0, amount));
  const base = round2(total / (1 + rate));
  return { base, vat: round2(total - base), total };
}

/** Card-header name for a partner. Real venues map to many POS categories
 *  (จ้อจี้ - COFFEE, - NON-COFFEE, - MATCHA, …), so the sent report shows the
 *  single partner name (venue if set) instead of the joined category list —
 *  the categories still drive which POS rows sum into this partner, they're
 *  just not printed on the card (owner 2026-07-25). */
export function partnerShopName(p: { name: string; venue?: string | null }): string {
  return p.venue?.trim() || p.name;
}

/** Whether a stored sales_amount already carries VAT. Only 'nett' (POS col 10 —
 *  incl. VAT + service charge) is VAT-inclusive; 'gross' and 'after_discount'
 *  are pre-VAT list amounts (owner 2026-07-25). */
export function salesBaseIncludesVat(base: SalesBase): boolean {
  return base === "nett";
}

/** VAT split for the daily/weekly sales cards, honouring the partner's
 *  sales_base. When the figure is VAT-inclusive ('nett'), divide it out; when
 *  it is pre-VAT ('gross'/'after_discount'), ADD VAT on top. The card was
 *  always dividing, so a pre-VAT figure like 2,630 was shown as base 2,457.94
 *  (÷1.07) instead of base 2,630 + VAT 184.10 (owner 2026-07-25). */
export function salesVat(
  amount: number, rate = 0.07, includesVat = false
): { base: number; vat: number; total: number } {
  if (includesVat) return vatInclusive(amount, rate);
  const base = round2(Math.max(0, amount));
  return { base, vat: round2(base * rate), total: round2(base * (1 + rate)) };
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
  // Staff drink-welfare total the company OWES this partner for the month
  // (จ้อจี้), VAT-inclusive — owner 2026-07-30. NO GP is taken on it; it is a
  // pure pass-through the company pays the partner, so it reduces what the
  // partner nets out on the GP invoice. Default 0.
  drinkPassthrough?: number;
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
  netAmount: number;     // billedGP + VAT − WHT (the GP invoice the partner pays)
  drinkPassthrough: number; // staff drink welfare the company pays the partner (no GP)
  drinkInputVat: number;    // VAT embedded in the (VAT-inclusive) drink amount — info only
  netAfterDrinks: number;   // netAmount − drinkPassthrough — final settlement
                            //   (> 0 partner pays company, < 0 company pays partner)
};

/** Monthly settlement. VAT (output) and WHT both sit on the billed GP (WHT base
 *  is GP BEFORE vat — the two don't compound). The staff drink-welfare
 *  pass-through (no GP) nets against the GP invoice. */
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
  const drinkPassthrough = round2(Math.max(0, inp.drinkPassthrough ?? 0));
  // Input VAT embedded in the VAT-inclusive drink price (info: company claims it).
  const drinkInputVat = inp.vatRate > 0
    ? round2(drinkPassthrough * inp.vatRate / (1 + inp.vatRate))
    : 0;
  const netAfterDrinks = round2(netAmount - drinkPassthrough);
  return {
    totalSales, tierGP, floorApplied, billedGP: round2(billedGP), topup,
    avgGpPct, vatAmount, whtAmount, netAmount,
    drinkPassthrough, drinkInputVat, netAfterDrinks
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

// Owner 2026-06-23: minimum billed GP is a flat 20,000 บาท/เดือน (20% of the
// 100,000 baseline they agreed on) — if tier GP comes out below it, bill 20,000.
export const DEFAULT_FLOORS: Floor[] = [
  { monthFrom: 1, monthTo: 120, amount: 20_000 }
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

/** A label for a round's date span — full month names + พ.ศ. year, no
 *  abbreviations (owner 2026-06-23: ทั้งระบบไม่ใช้ตัวย่อ). e.g.
 *  "19 มิถุนายน 2569" (one day), "15–21 มิถุนายน 2569" (same month/year),
 *  "30 มิถุนายน – 6 กรกฎาคม 2569" (cross-month). */
export function roundLabel(startIso: string, endIso: string): string {
  const [sy, sm, sd] = startIso.split("-").map(Number);
  const [ey, em, ed] = endIso.split("-").map(Number);
  const syB = sy + 543, eyB = ey + 543;
  if (startIso === endIso) return `${sd} ${TH_MONTHS_FULL[sm]} ${syB}`;
  if (sy === ey && sm === em) return `${sd}–${ed} ${TH_MONTHS_FULL[sm]} ${syB}`;
  if (sy === ey) return `${sd} ${TH_MONTHS_FULL[sm]} – ${ed} ${TH_MONTHS_FULL[em]} ${eyB}`;
  return `${sd} ${TH_MONTHS_FULL[sm]} ${syB} – ${ed} ${TH_MONTHS_FULL[em]} ${eyB}`;
}

// ── Daily → weekly rollup (owner 2026-06-23: import POS daily, transfer weekly,
//    GP monthly) ──────────────────────────────────────────────────────────────

function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Monday (ISO week start) of the week containing `iso`. */
export function mondayOf(iso: string): string {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();   // 0=Sun..6=Sat
  return addDaysIso(iso, dow === 0 ? -6 : 1 - dow);
}

export type WeekGroup = { weekStart: string; start: string; end: string; label: string; sales: number };

/** Group daily entries into ISO weeks (Mon–Sun). Each group's label spans the
 *  actual days present (so a partial week at a month edge reads "29–30 มิ.ย.").
 *  Sorted by date. This is the weekly TRANSFER amount. */
export function groupDailyIntoWeeks(entries: Array<{ date: string; amount: number }>): WeekGroup[] {
  const m = new Map<string, { start: string; end: string; sales: number }>();
  for (const e of entries) {
    const wk = mondayOf(e.date);
    const g = m.get(wk);
    if (!g) m.set(wk, { start: e.date, end: e.date, sales: e.amount });
    else { g.sales += e.amount; if (e.date < g.start) g.start = e.date; if (e.date > g.end) g.end = e.date; }
  }
  return [...m.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([wk, g]) => ({ weekStart: wk, start: g.start, end: g.end, label: roundLabel(g.start, g.end), sales: round2(g.sales) }));
}
