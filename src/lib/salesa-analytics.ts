// SALESA — deep daily/weekly sales analytics (owner 2026-09-16). Pure compute
// over the imported daily rows + menu ranking. Feeds both the dashboard and the
// LINE cards. Weeks are ISO Mon–Sun (reusing revshare's helpers).

import { mondayOf, roundLabel, thaiDate } from "./revshare";
import type { MenuEntry } from "./salesa-parse";
import { getDaily, listRange, getMenu, menuRange, hourlyReceipts, itemUnitsRange, receiptItemSets, hasReceiptData, type DailyRow } from "./salesa-db";

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

export type ChannelSlice = { name: string; sales: number; qty: number; pct: number; avgTicket: number | null };
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
      .map(([name, m]) => ({ name, sales: round2(m.sales), qty: m.qty, pct: total > 0 ? round2((m.sales / total) * 100) : 0, avgTicket: m.qty > 0 ? round2(m.sales / m.qty) : null }))
      .sort((a, b) => b.sales - a.sales);
  };
  return {
    types: acc((d) => d.types.map((t) => ({ name: t.name, sales: t.sales, qty: t.qty }))),
    payments: acc((d) => d.payments.map((p) => ({ name: p.name, sales: p.total, qty: p.qty }))),
    sources: acc((d) => d.sources.map((s) => ({ name: s.name, sales: s.sales, qty: s.qty })))
  };
}

// ── Deeper marketing insights (owner 2026-09-18: เอาหมดเลย) ──────────────────

function monthMenu(branchId: number, year: number, month: number, kind: "item" | "category"): MenuEntry[] {
  const mm = String(month).padStart(2, "0");
  return menuRange(branchId, `${year}-${mm}-01`, `${year}-${mm}-${String(daysInMonth(year, month)).padStart(2, "0")}`, kind);
}

// #1 Menu engineering — classify menus by revenue (high/low vs median) × momentum
// (rising/falling vs last month). Star / Plowhorse / Puzzle / Dog.
export type MenuClass = { name: string; nett: number; deltaPct: number | null; isNew: boolean };
export type MenuEngineering = {
  stars: MenuClass[];        // high revenue + rising
  plowhorses: MenuClass[];   // high revenue + flat/falling
  puzzles: MenuClass[];      // low revenue + rising
  dogs: MenuClass[];         // low revenue + falling
  medianNett: number;
};
export function menuEngineering(branchId: number, year: number, month: number, topN = 6): MenuEngineering {
  const items = monthMenu(branchId, year, month, "item");
  const pm = month === 1 ? 12 : month - 1;
  const pmY = month === 1 ? year - 1 : year;
  const prev = new Map(monthMenu(branchId, pmY, pm, "item").map((m) => [m.name, m.nett]));
  if (!items.length) return { stars: [], plowhorses: [], puzzles: [], dogs: [], medianNett: 0 };
  const sorted = [...items].map((m) => m.nett).sort((a, b) => a - b);
  const medianNett = sorted[Math.floor(sorted.length / 2)];
  const classed: MenuClass[] = items.map((m) => {
    const isNew = !prev.has(m.name);
    return { name: m.name, nett: m.nett, isNew, deltaPct: isNew ? null : relPct(m.nett, prev.get(m.name) ?? 0) };
  });
  const rising = (c: MenuClass) => c.isNew || (c.deltaPct ?? 0) > 0;
  const high = (c: MenuClass) => c.nett >= medianNett;
  const pick = (pred: (c: MenuClass) => boolean) => classed.filter(pred).sort((a, b) => b.nett - a.nett).slice(0, topN);
  return {
    stars: pick((c) => high(c) && rising(c)),
    plowhorses: pick((c) => high(c) && !rising(c)),
    puzzles: pick((c) => !high(c) && rising(c)),
    dogs: pick((c) => !high(c) && !rising(c)),
    medianNett: round2(medianNett)
  };
}

// #2 Beverage / dessert attach — classify categories by name (auto; adjustable).
const BEV_RE = /wine|beer|เบียร์|soft\s*drink|ซอฟ|ดริ่ง|drink|coffee|กาแฟ|matcha|มัจฉะ|tea|ชา|juice|น้ำผลไม้|soda|โซดา|น้ำอัดลม|refreshing|tropical|non-coffee|mocktail|cocktail|เครื่องดื่ม|beverage|smoothie|latte|americano|espresso/i;
const DESSERT_RE = /cake|เค้ก|dessert|ของหวาน|ice\s*cream|ไอศ|shaved\s*ice|น้ำแข็งไส|pie|พาย|cheese\s*cake|บิงซู|โมจิ|pudding|บราวนี|brownie/i;
export type BeverageMix = {
  total: number;
  beverageNett: number; beveragePct: number;
  dessertNett: number; dessertPct: number;
  foodNett: number; foodPct: number;
  bevToFoodPct: number | null;   // beverage as % of food (attach signal)
};
export function beverageMix(branchId: number, year: number, month: number): BeverageMix {
  const cats = monthMenu(branchId, year, month, "category");
  let bev = 0, dessert = 0, food = 0;
  for (const c of cats) {
    if (BEV_RE.test(c.name)) bev += c.nett;
    else if (DESSERT_RE.test(c.name)) dessert += c.nett;
    else food += c.nett;
  }
  const total = round2(bev + dessert + food);
  const p = (x: number) => (total > 0 ? round2((x / total) * 100) : 0);
  return {
    total,
    beverageNett: round2(bev), beveragePct: p(bev),
    dessertNett: round2(dessert), dessertPct: p(dessert),
    foodNett: round2(food), foodPct: p(food),
    bevToFoodPct: food > 0 ? round2((bev / food) * 100) : null
  };
}

// #7 Revenue concentration (80/20) over the month's menus.
export type MenuConcentration = { itemCount: number; total: number; top5Pct: number | null; countFor80: number };
export function menuConcentration(branchId: number, year: number, month: number): MenuConcentration {
  const items = monthMenu(branchId, year, month, "item"); // already sorted desc
  const total = round2(items.reduce((s, m) => s + m.nett, 0));
  if (!items.length || total <= 0) return { itemCount: items.length, total, top5Pct: null, countFor80: 0 };
  const top5 = items.slice(0, 5).reduce((s, m) => s + m.nett, 0);
  let cum = 0, countFor80 = 0;
  for (const m of items) { cum += m.nett; countFor80++; if (cum / total >= 0.8) break; }
  return { itemCount: items.length, total, top5Pct: round2((top5 / total) * 100), countFor80 };
}

// #3 Guest metrics — party size (heads/bill) + spend per head, with MoM.
export type GuestMetrics = {
  avgPartySize: number | null; avgSpendPerHead: number | null;
  prevPartySize: number | null; partyMomPct: number | null;
  prevSpendPerHead: number | null; spendMomPct: number | null;
};
function monthTotals(branchId: number, year: number, month: number): { nett: number; bills: number; pax: number; days: number } {
  const mm = String(month).padStart(2, "0");
  const rows = listRange(branchId, `${year}-${mm}-01`, `${year}-${mm}-${String(daysInMonth(year, month)).padStart(2, "0")}`).filter((d) => d.has_sales);
  return { nett: rows.reduce((s, d) => s + d.nett, 0), bills: rows.reduce((s, d) => s + d.bill_count, 0), pax: rows.reduce((s, d) => s + d.pax, 0), days: rows.length };
}
export function guestMetrics(branchId: number, year: number, month: number): GuestMetrics {
  const t = monthTotals(branchId, year, month);
  const pm = month === 1 ? 12 : month - 1;
  const pmY = month === 1 ? year - 1 : year;
  const p = monthTotals(branchId, pmY, pm);
  const party = t.bills > 0 ? round2(t.pax / t.bills) : null;
  const spend = t.pax > 0 ? round2(t.nett / t.pax) : null;
  const prevParty = p.bills > 0 ? round2(p.pax / p.bills) : null;
  const prevSpend = p.pax > 0 ? round2(p.nett / p.pax) : null;
  return {
    avgPartySize: party, avgSpendPerHead: spend,
    prevPartySize: prevParty, partyMomPct: relPct(party ?? 0, prevParty),
    prevSpendPerHead: prevSpend, spendMomPct: relPct(spend ?? 0, prevSpend)
  };
}

// #5 Payday / weekend effect within the month.
export type RhythmInsight = {
  paydayAvgNett: number | null; otherAvgNett: number | null; paydayLiftPct: number | null; paydayDays: number;
  weekendAvgNett: number | null; weekdayAvgNett: number | null; weekendLiftPct: number | null;
};
export function rhythmInsight(branchId: number, year: number, month: number): RhythmInsight {
  const mm = String(month).padStart(2, "0");
  const rows = listRange(branchId, `${year}-${mm}-01`, `${year}-${mm}-${String(daysInMonth(year, month)).padStart(2, "0")}`).filter((d) => d.has_sales);
  const avg = (arr: DailyRow[]) => (arr.length ? round2(arr.reduce((s, d) => s + d.nett, 0) / arr.length) : null);
  const isPayday = (iso: string) => { const dd = Number(iso.slice(8, 10)); return dd === 15 || dd === 16 || dd >= 25; };
  const isWeekend = (iso: string) => { const w = new Date(`${iso}T00:00:00Z`).getUTCDay(); return w === 0 || w === 6; };
  const pay = rows.filter((d) => isPayday(d.sale_date));
  const other = rows.filter((d) => !isPayday(d.sale_date));
  const wknd = rows.filter((d) => isWeekend(d.sale_date));
  const wkdy = rows.filter((d) => !isWeekend(d.sale_date));
  const payAvg = avg(pay), otherAvg = avg(other), wkndAvg = avg(wknd), wkdyAvg = avg(wkdy);
  return {
    paydayAvgNett: payAvg, otherAvgNett: otherAvg, paydayLiftPct: relPct(payAvg ?? 0, otherAvg), paydayDays: pay.length,
    weekendAvgNett: wkndAvg, weekdayAvgNett: wkdyAvg, weekendLiftPct: relPct(wkndAvg ?? 0, wkdyAvg)
  };
}

// #6 Void / refund quality signal (month), with MoM on the void rate.
export type QualitySignal = {
  voidAmount: number; voidBillCount: number; refund: number;
  voidRatePct: number | null;      // void amount / gross
  voidBillRatePct: number | null;  // void bills / bills
  prevVoidRatePct: number | null;
  flag: boolean;                   // void rate above threshold
};
export function qualitySignal(branchId: number, year: number, month: number): QualitySignal {
  const mm = String(month).padStart(2, "0");
  const rows = listRange(branchId, `${year}-${mm}-01`, `${year}-${mm}-${String(daysInMonth(year, month)).padStart(2, "0")}`).filter((d) => d.has_sales);
  const sum = (get: (d: DailyRow) => number, arr: DailyRow[]) => arr.reduce((s, d) => s + get(d), 0);
  const gross = sum((d) => d.gross, rows);
  const bills = sum((d) => d.bill_count, rows);
  const voidAmount = round2(sum((d) => d.void_amount, rows));
  const voidRate = gross > 0 ? round2((voidAmount / gross) * 100) : null;
  const pm = month === 1 ? 12 : month - 1;
  const pmY = month === 1 ? year - 1 : year;
  const prm = String(pm).padStart(2, "0");
  const prevRows = listRange(branchId, `${pmY}-${prm}-01`, `${pmY}-${prm}-${String(daysInMonth(pmY, pm)).padStart(2, "0")}`).filter((d) => d.has_sales);
  const prevGross = sum((d) => d.gross, prevRows);
  const prevVoid = sum((d) => d.void_amount, prevRows);
  const prevVoidRate = prevGross > 0 ? round2((prevVoid / prevGross) * 100) : null;
  return {
    voidAmount, voidBillCount: sum((d) => d.void_bill_count, rows), refund: round2(sum((d) => d.refund, rows)),
    voidRatePct: voidRate,
    voidBillRatePct: bills > 0 ? round2((sum((d) => d.void_bill_count, rows) / bills) * 100) : null,
    prevVoidRatePct: prevVoidRate,
    flag: (voidRate ?? 0) > 2
  };
}

// ── Receipt insights (owner 2026-09-18): peak hour + basket + units ─────────

export type HourStat = { hour: number; bills: number; nett: number };
export type ItemUnits = { name: string; units: number; bills: number };
export type BasketPair = { a: string; b: string; count: number };
export type ReceiptInsights = {
  hasData: boolean;
  hourly: HourStat[];        // hours present, ascending
  peakHour: number | null;
  topUnits: ItemUnits[];     // best-sellers by units sold (excl staff)
  bottomUnits: ItemUnits[];  // fewest units among items present
  basket: BasketPair[];      // menus most often bought together
};

function monthRange(year: number, month: number): [string, string] {
  const mm = String(month).padStart(2, "0");
  return [`${year}-${mm}-01`, `${year}-${mm}-${String(daysInMonth(year, month)).padStart(2, "0")}`];
}

export function receiptInsights(branchId: number, year: number, month: number, topN = 8): ReceiptInsights {
  const [start, end] = monthRange(year, month);
  if (!hasReceiptData(branchId, start, end)) {
    return { hasData: false, hourly: [], peakHour: null, topUnits: [], bottomUnits: [], basket: [] };
  }
  const hourly = hourlyReceipts(branchId, start, end);
  const peak = hourly.reduce<HourStat | null>((p, h) => (p == null || h.nett > p.nett ? h : p), null);

  const units = itemUnitsRange(branchId, start, end);
  const topUnits = units.slice(0, topN);
  const bottomUnits = units.length > topN ? units.slice(-topN).reverse() : [];

  // Basket co-occurrence: count distinct-item pairs across non-staff bills.
  const pairCount = new Map<string, number>();
  for (const set of receiptItemSets(branchId, start, end)) {
    const names = [...new Set(set)].sort();
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      const key = JSON.stringify([names[i], names[j]]);
      pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
    }
  }
  const basket: BasketPair[] = [...pairCount.entries()]
    .map(([k, count]) => { const [a, b] = JSON.parse(k) as [string, string]; return { a, b, count }; })
    .filter((p) => p.count >= 2)
    .sort((x, y) => y.count - x.count)
    .slice(0, topN);

  return { hasData: true, hourly, peakHour: peak?.hour ?? null, topUnits, bottomUnits, basket };
}
