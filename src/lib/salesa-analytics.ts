// SALESA — deep daily/weekly sales analytics (owner 2026-09-16). Pure compute
// over the imported daily rows + menu ranking. Feeds both the dashboard and the
// LINE cards. Weeks are ISO Mon–Sun (reusing revshare's helpers).

import { mondayOf, roundLabel, thaiDate } from "./revshare";
import type { MenuEntry } from "./salesa-parse";
import { getDaily, listRange, getMenu, menuRange, type DailyRow } from "./salesa-db";

function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }
function pct(part: number, whole: number): number | null {
  return whole > 0 ? round2((part / whole) * 100) : null;
}

export type MenuRank = MenuEntry & { rank: number };

export type DailyAnalytics = {
  date: string;
  dateLabel: string;
  row: DailyRow;
  discountPct: number | null;   // |discount| / gross
  voidPct: number | null;
  prevDate: string | null;
  prevNett: number | null;
  nettVsPrevPct: number | null;
  avg7Nett: number | null;      // trailing up-to-7 days present (excl. today)
  avg7Days: number;
  nettVs7Pct: number | null;
  topItems: MenuRank[];
  bottomItems: MenuRank[];      // lowest-earning among the ranked menus present
  topCategories: MenuRank[];
};

/** Full analytics for one day. topN caps each menu list. */
export function dailyAnalytics(branchId: number, date: string, topN = 5): DailyAnalytics | null {
  const row = getDaily(branchId, date);
  if (!row) return null;

  // Previous day with imported sales (looks back up to 14 days).
  const back = listRange(branchId, addDaysIso(date, -14), addDaysIso(date, -1)).filter((d) => d.has_sales);
  const prev = back.length ? back[back.length - 1] : null;

  // Trailing 7 calendar days before `date` that have sales.
  const window7 = listRange(branchId, addDaysIso(date, -7), addDaysIso(date, -1)).filter((d) => d.has_sales);
  const avg7Nett = window7.length ? round2(window7.reduce((s, d) => s + d.nett, 0) / window7.length) : null;

  const menu = getMenu(branchId, date);
  const items = menu.items.map((m, i) => ({ ...m, rank: i + 1 }));
  const cats = menu.categories.map((m, i) => ({ ...m, rank: i + 1 }));

  return {
    date,
    dateLabel: thaiDate(date),
    row,
    discountPct: pct(Math.abs(row.discount), row.gross),
    voidPct: pct(row.void_amount, row.gross),
    prevDate: prev?.sale_date ?? null,
    prevNett: prev?.nett ?? null,
    nettVsPrevPct: prev && prev.nett > 0 ? round2(((row.nett - prev.nett) / prev.nett) * 100) : null,
    avg7Nett,
    avg7Days: window7.length,
    nettVs7Pct: avg7Nett && avg7Nett > 0 ? round2(((row.nett - avg7Nett) / avg7Nett) * 100) : null,
    topItems: items.slice(0, topN),
    // lowest-earning end of the ranked list (owner: เมนูขายน้อยสุด) — only
    // meaningful within the menus the POS export actually lists.
    bottomItems: items.length > topN ? items.slice(-topN).reverse() : [],
    topCategories: cats.slice(0, topN)
  };
}

export type WeeklyAnalytics = {
  weekStart: string;
  weekEnd: string;
  label: string;
  days: Array<{ date: string; dateLabel: string; nett: number; billCount: number; pax: number }>;
  dayCount: number;
  totalNett: number;
  totalBills: number;
  totalPax: number;
  totalDiscount: number;
  avgPerDay: number | null;
  avgPerBill: number | null;
  bestDate: string | null;
  bestNett: number | null;
  topItems: MenuRank[];
  topCategories: MenuRank[];
};

/** Weekly rollup for the ISO week starting `weekStart` (a Monday). */
export function weeklyAnalytics(branchId: number, weekStart: string, topN = 5): WeeklyAnalytics {
  const start = mondayOf(weekStart);
  const end = addDaysIso(start, 6);
  const rows = listRange(branchId, start, end).filter((d) => d.has_sales);

  const days = rows.map((d) => ({
    date: d.sale_date, dateLabel: thaiDate(d.sale_date), nett: d.nett, billCount: d.bill_count, pax: d.pax
  }));
  const totalNett = round2(rows.reduce((s, d) => s + d.nett, 0));
  const totalBills = rows.reduce((s, d) => s + d.bill_count, 0);
  const totalPax = rows.reduce((s, d) => s + d.pax, 0);
  const totalDiscount = round2(rows.reduce((s, d) => s + d.discount, 0));
  const best = rows.reduce<DailyRow | null>((b, d) => (b == null || d.nett > b.nett ? d : b), null);

  const items = menuRange(branchId, start, end, "item").map((m, i) => ({ ...m, rank: i + 1 }));
  const cats = menuRange(branchId, start, end, "category").map((m, i) => ({ ...m, rank: i + 1 }));

  return {
    weekStart: start,
    weekEnd: end,
    label: roundLabel(days[0]?.date ?? start, days[days.length - 1]?.date ?? end),
    days,
    dayCount: rows.length,
    totalNett,
    totalBills,
    totalPax,
    totalDiscount,
    avgPerDay: rows.length ? round2(totalNett / rows.length) : null,
    avgPerBill: totalBills > 0 ? round2(totalNett / totalBills) : null,
    bestDate: best?.sale_date ?? null,
    bestNett: best?.nett ?? null,
    topItems: items.slice(0, topN),
    topCategories: cats.slice(0, topN)
  };
}
