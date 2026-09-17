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
  // Week-over-week comparison vs the previous ISO week (owner 2026-09-17).
  prevWeekDays: number;
  prevWeekNett: number | null;
  wowNettPct: number | null;
  wowBillsPct: number | null;
  wowPaxPct: number | null;
  topItems: MenuRank[];
  topCategories: MenuRank[];
  menuRisers: MenuMomentum[];   // biggest revenue gains vs last week (owner B)
  menuFallers: MenuMomentum[];  // biggest revenue drops vs last week
};

/** A menu's week-over-week revenue change (owner 2026-09-17, B). */
export type MenuMomentum = {
  name: string;
  thisNett: number;
  prevNett: number;
  deltaPct: number | null;   // null when it's brand-new this week (no prior)
  isNew: boolean;
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

  // Previous ISO week totals (owner 2026-09-17: เทียบสัปดาห์ก่อน).
  const prevStart = addDaysIso(start, -7);
  const prevEnd = addDaysIso(start, -1);
  const prevRows = listRange(branchId, prevStart, prevEnd).filter((d) => d.has_sales);
  const prevNett = prevRows.length ? round2(prevRows.reduce((s, d) => s + d.nett, 0)) : null;
  const prevBills = prevRows.reduce((s, d) => s + d.bill_count, 0);
  const prevPax = prevRows.reduce((s, d) => s + d.pax, 0);

  // Menu momentum: this week's item revenue vs the previous week's (owner B).
  const prevItems = new Map(menuRange(branchId, prevStart, prevEnd, "item").map((m) => [m.name, m.nett]));
  const momentum: MenuMomentum[] = items.map((m) => {
    const prevNett = prevItems.get(m.name) ?? 0;
    const isNew = !prevItems.has(m.name);
    return { name: m.name, thisNett: m.nett, prevNett, isNew, deltaPct: relPct(m.nett, prevNett) };
  });
  // Risers: biggest positive delta% (established menus), then new menus by size.
  const withPrev = momentum.filter((m) => !m.isNew && m.deltaPct != null);
  const menuRisers = [...withPrev].filter((m) => (m.deltaPct ?? 0) > 0).sort((a, b) => (b.deltaPct ?? 0) - (a.deltaPct ?? 0)).slice(0, topN);
  const menuFallers = [...withPrev].filter((m) => (m.deltaPct ?? 0) < 0).sort((a, b) => (a.deltaPct ?? 0) - (b.deltaPct ?? 0)).slice(0, topN);

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
    prevWeekDays: prevRows.length,
    prevWeekNett: prevNett,
    wowNettPct: relPct(totalNett, prevNett),
    wowBillsPct: prevBills > 0 ? relPct(totalBills, prevBills) : null,
    wowPaxPct: prevPax > 0 ? relPct(totalPax, prevPax) : null,
    topItems: items.slice(0, topN),
    topCategories: cats.slice(0, topN),
    menuRisers,
    menuFallers
  };
}

// ── F · monthly summary (for the LINE card sent on the 1st) ─────────────────

export type MonthlyAnalytics = {
  year: number;
  month: number;
  ym: string;
  label: string;               // "กันยายน 2569"
  dayCount: number;
  totalNett: number;
  totalBills: number;
  totalPax: number;
  totalDiscount: number;
  avgPerDay: number | null;
  avgPerBill: number | null;
  bestDate: string | null;
  bestNett: number | null;
  prevMonthNett: number | null;
  prevMonthPct: number | null;
  lastYearNett: number | null;
  lastYearPct: number | null;
  topItems: MenuRank[];
  topCategories: MenuRank[];
};

const TH_MONTHS_LOCAL = ["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];

/** Whole-month rollup + MoM/YoY (full month) + top menus (owner F). */
export function monthlyAnalytics(branchId: number, year: number, month: number, topN = 5): MonthlyAnalytics {
  const mm = String(month).padStart(2, "0");
  const end = `${year}-${mm}-${String(daysInMonth(year, month)).padStart(2, "0")}`;
  const rows = listRange(branchId, `${year}-${mm}-01`, end).filter((d) => d.has_sales);
  const totalNett = round2(rows.reduce((s, d) => s + d.nett, 0));
  const totalBills = rows.reduce((s, d) => s + d.bill_count, 0);
  const totalPax = rows.reduce((s, d) => s + d.pax, 0);
  const totalDiscount = round2(rows.reduce((s, d) => s + d.discount, 0));
  const best = rows.reduce<DailyRow | null>((b, d) => (b == null || d.nett > b.nett ? d : b), null);
  const full = daysInMonth(year, month);
  const pm = month === 1 ? 12 : month - 1;
  const pmY = month === 1 ? year - 1 : year;
  const prevMonthNett = sumNett(branchId, pmY, pm, full);
  const lastYearNett = sumNett(branchId, year - 1, month, full);
  const items = menuRange(branchId, `${year}-${mm}-01`, end, "item").map((m, i) => ({ ...m, rank: i + 1 }));
  const cats = menuRange(branchId, `${year}-${mm}-01`, end, "category").map((m, i) => ({ ...m, rank: i + 1 }));

  return {
    year, month, ym: `${year}-${mm}`,
    label: `${TH_MONTHS_LOCAL[month]} ${year + 543}`,
    dayCount: rows.length,
    totalNett, totalBills, totalPax, totalDiscount,
    avgPerDay: rows.length ? round2(totalNett / rows.length) : null,
    avgPerBill: totalBills > 0 ? round2(totalNett / totalBills) : null,
    bestDate: best?.sale_date ?? null,
    bestNett: best?.nett ?? null,
    prevMonthNett, prevMonthPct: relPct(totalNett, prevMonthNett),
    lastYearNett, lastYearPct: relPct(totalNett, lastYearNett),
    topItems: items.slice(0, topN),
    topCategories: cats.slice(0, topN)
  };
}

// ── C · monthly target progress ─────────────────────────────────────────────

export type TargetProgress = {
  target: number;
  mtdNett: number;
  throughDay: number;
  daysInMonth: number;
  pctOfTarget: number;         // MTD / target
  projectedNett: number;       // linear pace to month end
  projectedPct: number;        // projected / target
  onTrack: boolean;
};

/** Progress toward a monthly sales target given MTD (owner C). */
export function targetProgress(target: number, mtdNett: number, throughDay: number, year: number, month: number): TargetProgress | null {
  if (!(target > 0)) return null;
  const dim = daysInMonth(year, month);
  const projectedNett = throughDay > 0 ? round2((mtdNett / throughDay) * dim) : 0;
  return {
    target,
    mtdNett,
    throughDay,
    daysInMonth: dim,
    pctOfTarget: round2((mtdNett / target) * 100),
    projectedNett,
    projectedPct: round2((projectedNett / target) * 100),
    onTrack: projectedNett >= target
  };
}

// ── A · weekday performance, D · discount insight, E · channel mix ──────────

export type WeekdayStat = { dow: number; label: string; avgNett: number; days: number; avgBills: number };

/** Average sales per weekday over a trailing window (default 8 weeks) ending at
 *  `refIso` (owner A: หาว่าวันไหนขายดี/ร้าง). */
export function weekdayStats(branchId: number, refIso: string, lookbackDays = 56): WeekdayStat[] {
  const rows = listRange(branchId, addDaysIso(refIso, -lookbackDays + 1), refIso).filter((d) => d.has_sales);
  const buckets = new Map<number, { nett: number; bills: number; n: number }>();
  for (const d of rows) {
    const dow = new Date(`${d.sale_date}T00:00:00Z`).getUTCDay();
    const b = buckets.get(dow) ?? { nett: 0, bills: 0, n: 0 };
    b.nett += d.nett; b.bills += d.bill_count; b.n += 1;
    buckets.set(dow, b);
  }
  // Mon-first ordering (1..6,0).
  const order = [1, 2, 3, 4, 5, 6, 0];
  return order.map((dow) => {
    const b = buckets.get(dow);
    return {
      dow, label: TH_WEEKDAYS[dow],
      avgNett: b && b.n ? round2(b.nett / b.n) : 0,
      days: b?.n ?? 0,
      avgBills: b && b.n ? Math.round(b.bills / b.n) : 0
    };
  });
}

export type DiscountInsight = {
  avgDiscountPct: number | null;   // month avg |discount|/gross
  totalDiscount: number;
  highDiscAvgNett: number | null;  // avg nett on above-median-discount days
  lowDiscAvgNett: number | null;   // avg nett on at-or-below-median days
  days: number;
};

/** Discount ROI signal for a month (owner D): does heavier discounting move
 *  sales? Split days by median discount% and compare average nett. */
export function discountInsight(branchId: number, year: number, month: number): DiscountInsight {
  const mm = String(month).padStart(2, "0");
  const rows = listRange(branchId, `${year}-${mm}-01`, `${year}-${mm}-${String(daysInMonth(year, month)).padStart(2, "0")}`)
    .filter((d) => d.has_sales && d.gross > 0);
  if (!rows.length) return { avgDiscountPct: null, totalDiscount: 0, highDiscAvgNett: null, lowDiscAvgNett: null, days: 0 };
  const withPct = rows.map((d) => ({ nett: d.nett, dpct: Math.abs(d.discount) / d.gross }));
  const totalDiscount = round2(rows.reduce((s, d) => s + Math.abs(d.discount), 0));
  const avgDiscountPct = round2((withPct.reduce((s, d) => s + d.dpct, 0) / withPct.length) * 100);
  const sorted = [...withPct].sort((a, b) => a.dpct - b.dpct);
  const median = sorted[Math.floor(sorted.length / 2)].dpct;
  const high = withPct.filter((d) => d.dpct > median);
  const low = withPct.filter((d) => d.dpct <= median);
  const avg = (arr: { nett: number }[]) => (arr.length ? round2(arr.reduce((s, d) => s + d.nett, 0) / arr.length) : null);
  return { avgDiscountPct, totalDiscount, highDiscAvgNett: avg(high), lowDiscAvgNett: avg(low), days: rows.length };
}

export type ChannelSlice = { name: string; sales: number; qty: number; pct: number };
export type ChannelMix = { types: ChannelSlice[]; payments: ChannelSlice[]; sources: ChannelSlice[] };

/** Aggregate order types / payment methods / sources over a month, with each
 *  slice's share of the total (owner E). */
export function monthChannelMix(branchId: number, year: number, month: number): ChannelMix {
  const mm = String(month).padStart(2, "0");
  const rows = listRange(branchId, `${year}-${mm}-01`, `${year}-${mm}-${String(daysInMonth(year, month)).padStart(2, "0")}`)
    .filter((d) => d.has_sales);
  const acc = (pick: (d: DailyRow) => Array<{ name: string; sales: number; qty: number }>): ChannelSlice[] => {
    const map = new Map<string, { sales: number; qty: number }>();
    for (const d of rows) for (const e of pick(d)) {
      const m = map.get(e.name) ?? { sales: 0, qty: 0 };
      m.sales += e.sales; m.qty += e.qty; map.set(e.name, m);
    }
    const total = [...map.values()].reduce((s, m) => s + m.sales, 0);
    return [...map.entries()]
      .map(([name, m]) => ({ name, sales: round2(m.sales), qty: m.qty, pct: total > 0 ? round2((m.sales / total) * 100) : 0 }))
      .sort((a, b) => b.sales - a.sales);
  };
  return {
    types: acc((d) => d.types.map((t) => ({ name: t.name, sales: t.sales, qty: t.qty }))),
    payments: acc((d) => d.payments.map((p) => ({ name: p.name, sales: p.total, qty: p.qty }))),
    sources: acc((d) => d.sources.map((s) => ({ name: s.name, sales: s.sales, qty: s.qty })))
  };
}
