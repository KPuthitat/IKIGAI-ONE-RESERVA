// Per-partner revenue-share analysis (owner 2026-10-31). Read-only composer over the rounds, catch-ups,
// stored settlements and ANALYTICA category sales — nothing here writes. Month GP is the tier (marginal)
// GP of that month's own sales; the minimum-bill floor only shows up through a stored settlement's billedGP.

import { getDb } from "./db";
import { marginalGP, round2, type Tier } from "./revshare";
import {
  getPartner, getTiers, listRounds, listCatchups, getStoredSettlement, partnerCategorySalesForMonths,
  type RsPartner
} from "./revshare-db";

const DOW_TH = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

export type MonthRow = {
  ym: string; sales: number; catchup: number; activeDays: number; avgPerDay: number;
  tierGP: number; gpPct: number; momPct: number | null;
  settlement: { status: "draft" | "issued" | "paid"; billedGP: number; invoiceNo: string | null } | null;
};
export type TierPosition = {
  ym: string; sales: number; currentRate: number; nextRate: number | null; nextFrom: number | null; remaining: number | null;
};
export type PartnerAnalysis = {
  partner: Pick<RsPartner, "id" | "name" | "venue" | "sales_base">;
  months: MonthRow[];
  totals: { sales: number; tierGP: number; gpPct: number; catchup: number; catchupPct: number; activeDays: number; avgPerDay: number };
  weekdays: Array<{ dow: number; label: string; days: number; avg: number }>;
  bestDays: Array<{ date: string; sales: number }>;
  categories: Array<{ name: string; sales: number; sharePct: number }>;
  tier: TierPosition | null;
  pace: { ym: string; throughDay: number; daysInMonth: number; mtd: number; projected: number; projectedGP: number } | null;
};

function monthsEndingAt(endYm: string, n: number): string[] {
  const [y, m] = endYm.split("-").map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}
function daysInMonth(ym: string): number { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

/** Rate of the tier a sales figure currently sits in, plus the next tier's start. */
export function tierPosition(sales: number, tiers: Tier[]): Omit<TierPosition, "ym"> | null {
  if (tiers.length === 0) return null;
  const sorted = [...tiers].sort((a, b) => a.lower - b.lower);
  let idx = 0;
  for (let i = 0; i < sorted.length; i++) if (sales >= sorted[i].lower) idx = i;
  const cur = sorted[idx], next = sorted[idx + 1] ?? null;
  return {
    sales: round2(sales), currentRate: cur.rate, nextRate: next?.rate ?? null,
    nextFrom: next?.lower ?? null, remaining: next ? round2(Math.max(0, next.lower - sales)) : null
  };
}

export function partnerAnalysis(partnerId: number, branchId: number, endYm: string, nMonths: number, todayIso: string): PartnerAnalysis | null {
  const partner = getPartner(partnerId, branchId);
  if (!partner) return null;
  const tiers = getTiers(partnerId);
  const yms = monthsEndingAt(endYm, Math.min(Math.max(nMonths, 1), 24));

  const dowAgg = new Map<number, { sum: number; days: number }>();
  const dayList: Array<{ date: string; sales: number }> = [];
  const months: MonthRow[] = [];
  let prevSales: number | null = null;
  for (const ym of yms) {
    const [y, m] = ym.split("-").map(Number);
    const rounds = listRounds(partnerId, branchId, y, m);
    const catchups = listCatchups(partnerId, branchId, y, m);
    const catchup = round2(catchups.reduce((s, c) => s + c.sales_amount, 0));
    const roundSales = rounds.reduce((s, r) => s + r.sales_amount, 0);
    const sales = round2(roundSales + catchup);
    // Day-level analysis uses single-day rows only (a multi-day round has no day to attribute to).
    const daily = rounds.filter((r) => r.period_start === r.period_end && r.sales_amount > 0);
    for (const r of daily) {
      dayList.push({ date: r.period_start, sales: r.sales_amount });
      const dow = new Date(`${r.period_start}T00:00:00Z`).getUTCDay();
      const a = dowAgg.get(dow) ?? { sum: 0, days: 0 };
      a.sum += r.sales_amount; a.days += 1; dowAgg.set(dow, a);
    }
    const tierGP = round2(marginalGP(sales, tiers));
    const st = getStoredSettlement(partnerId, branchId, y, m);
    months.push({
      ym, sales, catchup, activeDays: daily.length, avgPerDay: daily.length ? round2(daily.reduce((s, r) => s + r.sales_amount, 0) / daily.length) : 0,
      tierGP, gpPct: sales > 0 ? tierGP / sales : 0,
      momPct: prevSales != null && prevSales > 0 ? (sales - prevSales) / prevSales : null,
      settlement: st ? { status: st.status, billedGP: st.billedGP, invoiceNo: st.invoice_no } : null
    });
    prevSales = sales;
  }

  const sum = (f: (r: MonthRow) => number) => round2(months.reduce((s, r) => s + f(r), 0));
  const totalSales = sum((r) => r.sales), totalGP = sum((r) => r.tierGP), totalCatchup = sum((r) => r.catchup), totalDays = months.reduce((s, r) => s + r.activeDays, 0);
  const dayTotal = dayList.reduce((s, d) => s + d.sales, 0);

  const cats = partnerCategorySalesForMonths(branchId, partner.pos_categories, yms);
  const catTotal = cats.reduce((s, c) => s + c.sales, 0);

  const last = months[months.length - 1];
  const pos = tierPosition(last.sales, tiers);

  // Run-rate projection only for the month still in progress.
  let pace: PartnerAnalysis["pace"] = null;
  if (todayIso.slice(0, 7) === last.ym) {
    const throughDay = Number(todayIso.slice(8, 10)), dim = daysInMonth(last.ym);
    if (throughDay >= 1 && throughDay < dim && last.sales > 0) {
      const projected = round2(last.sales / throughDay * dim);
      pace = { ym: last.ym, throughDay, daysInMonth: dim, mtd: last.sales, projected, projectedGP: round2(marginalGP(projected, tiers)) };
    }
  }

  return {
    partner: { id: partner.id, name: partner.name, venue: partner.venue, sales_base: partner.sales_base },
    months,
    totals: {
      sales: totalSales, tierGP: totalGP, gpPct: totalSales > 0 ? totalGP / totalSales : 0, catchup: totalCatchup,
      catchupPct: totalSales > 0 ? totalCatchup / totalSales : 0, activeDays: totalDays, avgPerDay: totalDays ? round2(dayTotal / totalDays) : 0
    },
    weekdays: [1, 2, 3, 4, 5, 6, 0].map((dow) => {
      const a = dowAgg.get(dow);
      return { dow, label: DOW_TH[dow], days: a?.days ?? 0, avg: a ? round2(a.sum / a.days) : 0 };
    }),
    bestDays: dayList.sort((a, b) => b.sales - a.sales).slice(0, 5),
    categories: cats.map((c) => ({ name: c.name, sales: round2(c.sales), sharePct: catTotal > 0 ? c.sales / catTotal : 0 })),
    tier: pos ? { ym: last.ym, ...pos } : null,
    pace
  };
}

/** Active partners of a branch, for the page's picker. */
export function analysisPartners(branchId: number): Array<{ id: number; name: string }> {
  return (getDb().prepare("SELECT id, name FROM revshare_partners WHERE branch_id = ? AND active = 1 ORDER BY name COLLATE NOCASE").all(branchId) as Array<{ id: number; name: string }>);
}
