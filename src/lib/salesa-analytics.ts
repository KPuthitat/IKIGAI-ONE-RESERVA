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
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
/** Same day-of-month, previous month. Null when that day doesn't exist there
 *  (e.g. the 31st has no counterpart in a 30-day month). */
function sameDayLastMonthIso(iso: string): string | null {
  const [y, m, d] = iso.split("-").map(Number);
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  if (d > daysInMonth(py, pm)) return null;
  return `${py}-${String(pm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
const TH_WEEKDAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
function thaiWeekday(iso: string): string {
  return TH_WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];
}
function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }
function pct(part: number, whole: number): number | null {
  return whole > 0 ? round2((part / whole) * 100) : null;
}
function relPct(today: number, base: number | null | undefined): number | null {
  return base != null && base > 0 ? round2(((today - base) / base) * 100) : null;
}

export type MenuRank = MenuEntry & { rank: number };

/** One KPI with two business-meaningful comparisons (owner 2026-09-17):
 *  the same weekday last week, and the same day-of-month last month. */
export type MetricCompare = {
  key: string;
  label: string;
  value: number;
  kind: "baht" | "int";
  wowPct: number | null;    // vs same weekday last week (−7 days)
  momPct: number | null;    // vs same day-of-month last month
};

export type DailyAnalytics = {
  date: string;
  dateLabel: string;
  row: DailyRow;
  discountPct: number | null;   // |discount| / gross
  voidPct: number | null;
  weekdayTh: string;            // this day's Thai weekday (for the WoW label)
  dom: number;                  // this day's day-of-month (for the MoM label)
  wowLabel: string;             // e.g. "จันทร์ที่แล้ว"
  momLabel: string;             // e.g. "วันที่ 1 เดือนก่อน"
  wowHasData: boolean;          // same weekday last week was imported
  momHasData: boolean;          // same day last month was imported
  metrics: MetricCompare[];     // nett, bills, pax, avg/bill, avg/head
  topItems: MenuRank[];
  bottomItems: MenuRank[];      // lowest-earning among the ranked menus present
  topCategories: MenuRank[];
};

/** Full analytics for one day. topN caps each menu list. */
export function dailyAnalytics(branchId: number, date: string, topN = 5): DailyAnalytics | null {
  const row = getDaily(branchId, date);
  if (!row) return null;

  // Same weekday last week (−7d) and same day-of-month last month.
  const wowRow = getDaily(branchId, addDaysIso(date, -7));
  const momIso = sameDayLastMonthIso(date);
  const momRow = momIso ? getDaily(branchId, momIso) : null;
  const wowHasData = !!wowRow && wowRow.has_sales === 1;
  const momHasData = !!momRow && momRow.has_sales === 1;

  const defs: Array<{ key: string; label: string; kind: "baht" | "int"; get: (d: DailyRow) => number }> = [
    { key: "nett", label: "ยอดขายสุทธิ", kind: "baht", get: (d) => d.nett },
    { key: "bills", label: "จำนวนบิล", kind: "int", get: (d) => d.bill_count },
    { key: "pax", label: "ลูกค้า", kind: "int", get: (d) => d.pax },
    { key: "avgBill", label: "เฉลี่ยต่อบิล", kind: "baht", get: (d) => d.avg_sales },
    { key: "avgHead", label: "เฉลี่ยต่อหัว", kind: "baht", get: (d) => d.avg_sales_pax }
  ];
  const metrics: MetricCompare[] = defs.map((m) => {
    const value = m.get(row);
    return {
      key: m.key, label: m.label, value, kind: m.kind,
      wowPct: wowHasData ? relPct(value, m.get(wowRow!)) : null,
      momPct: momHasData ? relPct(value, m.get(momRow!)) : null
    };
  });

  const menu = getMenu(branchId, date);
  const items = menu.items.map((m, i) => ({ ...m, rank: i + 1 }));
  const cats = menu.categories.map((m, i) => ({ ...m, rank: i + 1 }));
  const dom = Number(date.slice(8, 10));
  const weekdayTh = thaiWeekday(date);

  return {
    date,
    dateLabel: thaiDate(date),
    row,
    discountPct: pct(Math.abs(row.discount), row.gross),
    voidPct: pct(row.void_amount, row.gross),
    weekdayTh,
    dom,
    wowLabel: `${weekdayTh}ที่แล้ว`,
    momLabel: `วันที่ ${dom} เดือนก่อน`,
    wowHasData,
    momHasData,
    metrics,
    topItems: items.slice(0, topN),
    // lowest-earning end of the ranked list (owner: เมนูขายน้อยสุด) — only
    // meaningful within the menus the POS export actually lists.
    bottomItems: items.length > topN ? items.slice(-topN).reverse() : [],
    topCategories: cats.slice(0, topN)
  };
}

/** Month-level cumulative comparisons (owner 2026-09-17): month-to-date this
 *  month vs the same day-count last month, and vs the same month last year.
 *  `throughDay` is the last day-of-month covered — today for the current month,
 *  else the latest imported day. Null pcts when there's no baseline to compare. */
export type MonthComparison = {
  year: number;
  month: number;
  throughDay: number;          // 0 = no data this month
  mtdNett: number;             // Σ nett, day 1..throughDay this month
  prevMonthNett: number | null;
  prevMonthPct: number | null; // bullet 4: MTD this vs last month
  lastYearNett: number | null;
  lastYearPct: number | null;  // bullet 3: this month vs same month last year (same day-count)
};

function sumNett(branchId: number, year: number, month: number, throughDay: number): number | null {
  if (throughDay < 1) return null;
  const mm = String(month).padStart(2, "0");
  const last = Math.min(throughDay, daysInMonth(year, month));
  const rows = listRange(branchId, `${year}-${mm}-01`, `${year}-${mm}-${String(last).padStart(2, "0")}`)
    .filter((d) => d.has_sales);
  if (!rows.length) return null;
  return round2(rows.reduce((s, d) => s + d.nett, 0));
}

export function monthComparison(branchId: number, year: number, month: number, todayIso: string): MonthComparison {
  const rows = listRange(branchId, `${year}-${String(month).padStart(2, "0")}-01`,
    `${year}-${String(month).padStart(2, "0")}-${String(daysInMonth(year, month)).padStart(2, "0")}`)
    .filter((d) => d.has_sales);
  const isCurrentMonth = todayIso.startsWith(`${year}-${String(month).padStart(2, "0")}`);
  // Cover through today (current month) or through the latest imported day.
  const maxImported = rows.reduce((mx, d) => Math.max(mx, Number(d.sale_date.slice(8, 10))), 0);
  const throughDay = isCurrentMonth ? Number(todayIso.slice(8, 10)) : maxImported;

  const mtdNett = sumNett(branchId, year, month, throughDay) ?? 0;
  const pm = month === 1 ? 12 : month - 1;
  const pmY = month === 1 ? year - 1 : year;
  const prevMonthNett = sumNett(branchId, pmY, pm, throughDay);
  const lastYearNett = sumNett(branchId, year - 1, month, throughDay);

  return {
    year, month, throughDay,
    mtdNett,
    prevMonthNett,
    prevMonthPct: relPct(mtdNett, prevMonthNett),
    lastYearNett,
    lastYearPct: relPct(mtdNett, lastYearNett)
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
