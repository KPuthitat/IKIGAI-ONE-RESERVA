// SALESA — deep daily/weekly sales analytics (owner 2026-09-16). Pure compute
// over the imported daily rows + menu ranking. Feeds both the dashboard and the
// LINE cards. Weeks are ISO Mon–Sun (reusing revshare's helpers).

import { mondayOf, roundLabel, thaiDate } from "./revshare";
import type { MenuEntry } from "./salesa-parse";
import { getDaily, listRange, getMenu, menuRange, hourlyReceipts, itemUnitsRange, receiptItemSets, hasReceiptData, getMonthlyTarget, branchIdsWithTarget, branchOpensOn, type DailyRow } from "./salesa-db";
import { getDb } from "./db";

function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
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

// `units` = จำนวนที่ขายได้ (owner calls it "ครั้ง"), joined from receipt data by
// name; null when there's no receipt match. Shown alongside revenue everywhere a
// menu is listed, so the kitchen can plan by volume, not just baht (owner 2026-09-20).
export type MenuRank = MenuEntry & { rank: number; units?: number | null };

/** Attach receipt units to a ranked menu list, matched by name. */
function attachUnits(list: MenuRank[], unitsByName: Map<string, number>): MenuRank[] {
  return list.map((m) => ({ ...m, units: unitsByName.get(m.name) ?? null }));
}

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
  peakHour: number | null;      // busiest hour by nett (receipt data), else null
  advice: string[];             // auto summary + short recommendations (2–4 lines)
};

/** Auto-generated executive summary + short recommendations for one day
 *  (owner 2026-09-18: "มี section ของการสรุป และคำแนะนำสั้นๆ"). Pure — reads
 *  only the already-computed daily figures. Headline first, then the most
 *  actionable notes; capped at 4 lines so the card stays skimmable. */
function dailyAdvice(a: {
  metrics: MetricCompare[];
  wowHasData: boolean; wowLabel: string;
  momHasData: boolean; momLabel: string;
  discountPct: number | null;
  voidPct: number | null;
  topItems: MenuRank[];
  peakHour: number | null;
}): string[] {
  const out: string[] = [];
  const nett = a.metrics[0];
  // 1) Headline: how today's sales compare (prefer same weekday last week).
  const trend = (pctv: number | null, label: string): string | null => {
    if (pctv == null) return null;
    if (pctv >= 5) return `ยอดขายสูงกว่า${label} +${pctv}% — โมเมนตัมดี รักษาจังหวะไว้`;
    if (pctv <= -5) return `ยอดขายต่ำกว่า${label} ${pctv}% — ทบทวนช่วงเวลา/โปรโมชัน`;
    return `ยอดขายใกล้เคียง${label} (${pctv >= 0 ? "+" : ""}${pctv}%)`;
  };
  const head = (a.wowHasData ? trend(nett.wowPct, a.wowLabel) : null)
    ?? (a.momHasData ? trend(nett.momPct, a.momLabel) : null);
  if (head) out.push(head);
  // 2) Warnings — most actionable, so ahead of the nicety below.
  if (a.discountPct != null && a.discountPct >= 8) out.push(`ส่วนลดสูง ${a.discountPct}% ของยอดรวม — ตรวจสอบการให้ส่วนลด`);
  if (a.voidPct != null && a.voidPct >= 3) out.push(`ยอดยกเลิก (void) ${a.voidPct}% — ตรวจสอบการกดยกเลิกบิล`);
  // 3) Operational tip: staff/stock the busiest hour.
  if (a.peakHour != null) out.push(`ช่วงขายดีสุด ${String(a.peakHour).padStart(2, "0")}:00 — จัดคน/สต๊อกให้พอ`);
  // 4) Positive highlight: the top-earning menu.
  if (a.topItems.length) out.push(`เมนูทำเงินสูงสุด: ${a.topItems[0].name}`);
  return out.slice(0, 4);
}

/** Busiest hour of a single day by nett (receipt data), or null. */
function dayPeakHour(branchId: number, date: string): number | null {
  if (!hasReceiptData(branchId, date, date)) return null;
  const hours = hourlyReceipts(branchId, date, date);
  if (!hours.length) return null;
  return hours.reduce((best, h) => (h.nett > best.nett ? h : best)).hour;
}

/** Full analytics for one day. topN caps each menu list. */
export function dailyAnalytics(branchId: number, date: string, topN = 5): DailyAnalytics | null {
  const row = getDaily(branchId, date);
  if (!row) return null;

  // Same weekday last week (−7d) for a day-to-day compare; and the same-period
  // MONTH-TO-DATE cumulative (day 1..today) vs the previous month's identical
  // window — owner 2026-09-21: เทียบ "ยอดสะสม 20 วันแรก" กับเดือนก่อน ไม่ใช่เทียบ
  // ยอดวันที่ 20 วันเดียว.
  const dom = Number(date.slice(8, 10));
  const dY = Number(date.slice(0, 4)), dM = Number(date.slice(5, 7));
  const pmM = dM === 1 ? 12 : dM - 1, pmY = dM === 1 ? dY - 1 : dY;
  const wowRow = getDaily(branchId, addDaysIso(date, -7));
  const wowHasData = !!wowRow && wowRow.has_sales === 1;
  const curAgg = aggMtd(branchId, dY, dM, dom);      // 1..today this month
  const prevAgg = aggMtd(branchId, pmY, pmM, dom);   // 1..same day last month
  const momHasData = !!curAgg && !!prevAgg;
  const cumVal = (agg: MtdAgg, key: string): number =>
    key === "bills" ? agg.bills
      : key === "pax" ? agg.pax
      : key === "avgBill" ? (agg.bills > 0 ? agg.nett / agg.bills : 0)
      : key === "avgHead" ? (agg.pax > 0 ? agg.nett / agg.pax : 0)
      : agg.nett;

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
      momPct: momHasData ? relPct(cumVal(curAgg!, m.key), cumVal(prevAgg!, m.key)) : null
    };
  });

  const menu = getMenu(branchId, date);
  const items = menu.items.map((m, i) => ({ ...m, rank: i + 1 }));
  const cats = menu.categories.map((m, i) => ({ ...m, rank: i + 1 }));
  const unitsByName = new Map(itemUnitsRange(branchId, date, date).map((u) => [u.name, u.units]));
  const weekdayTh = thaiWeekday(date);
  const discountPct = pct(Math.abs(row.discount), row.gross);
  const voidPct = pct(row.void_amount, row.gross);
  const peakHour = dayPeakHour(branchId, date);
  const topItems = attachUnits(items.slice(0, topN), unitsByName);

  return {
    date,
    dateLabel: thaiDate(date),
    row,
    discountPct,
    voidPct,
    weekdayTh,
    dom,
    wowLabel: `วัน${weekdayTh}ที่แล้ว`,
    momLabel: `สะสม ${dom} วันแรก · เดือนก่อน`,
    wowHasData,
    momHasData,
    metrics,
    topItems,
    // lowest-earning end of the ranked list (owner: เมนูขายน้อยสุด) — only
    // meaningful within the menus the POS export actually lists.
    bottomItems: items.length > topN ? attachUnits(items.slice(-topN).reverse(), unitsByName) : [],
    topCategories: cats.slice(0, topN),
    peakHour,
    advice: dailyAdvice({ metrics, wowHasData, wowLabel: `วัน${weekdayTh}ที่แล้ว`, momHasData, momLabel: `สะสม ${dom} วันแรก · เดือนก่อน`, discountPct, voidPct, topItems, peakHour })
  };
}

/** Month-level cumulative comparisons (owner 2026-09-17): month-to-date this
 *  month vs the same day-count last month, and vs the same month last year.
 *  `throughDay` is the last day-of-month covered — today for the current month,
 *  else the latest imported day. Null pcts when there's no baseline to compare. */
/** One same-period MTD metric: this month's day 1..N vs last month's day 1..N. */
export type MtdMetric = { key: string; label: string; kind: "baht" | "int"; value: number; prev: number | null; pct: number | null };

export type MonthComparison = {
  year: number;
  month: number;
  throughDay: number;          // 0 = no data this month
  mtdNett: number;             // Σ nett, day 1..throughDay this month
  prevMonthNett: number | null;
  prevMonthPct: number | null; // bullet 4: MTD this vs last month
  lastYearNett: number | null;
  lastYearPct: number | null;  // bullet 3: this month vs same month last year (same day-count)
  // Same-period (day 1..throughDay) trend across dimensions vs the previous
  // month's identical window — so the current partial month compares apples to
  // apples, not against a full month (owner 2026-09-20: ดูเทรนด์ 1–19 vs 1–19).
  trend: MtdMetric[];
};

type MtdAgg = { nett: number; bills: number; pax: number; discount: number; days: number };
function aggMtd(branchId: number, year: number, month: number, throughDay: number): MtdAgg | null {
  if (throughDay < 1) return null;
  const mm = String(month).padStart(2, "0");
  const last = Math.min(throughDay, daysInMonth(year, month));
  const rows = listRange(branchId, `${year}-${mm}-01`, `${year}-${mm}-${String(last).padStart(2, "0")}`)
    .filter((d) => d.has_sales);
  if (!rows.length) return null;
  return {
    nett: round2(rows.reduce((s, d) => s + d.nett, 0)),
    bills: rows.reduce((s, d) => s + d.bill_count, 0),
    pax: rows.reduce((s, d) => s + d.pax, 0),
    discount: round2(rows.reduce((s, d) => s + d.discount, 0)),
    days: rows.length
  };
}

function sumNett(branchId: number, year: number, month: number, throughDay: number): number | null {
  return aggMtd(branchId, year, month, throughDay)?.nett ?? null;
}

export function monthComparison(branchId: number, year: number, month: number, todayIso: string): MonthComparison {
  const rows = listRange(branchId, `${year}-${String(month).padStart(2, "0")}-01`,
    `${year}-${String(month).padStart(2, "0")}-${String(daysInMonth(year, month)).padStart(2, "0")}`)
    .filter((d) => d.has_sales);
  const isCurrentMonth = todayIso.startsWith(`${year}-${String(month).padStart(2, "0")}`);
  // Cover through today (current month) or through the latest imported day.
  const maxImported = rows.reduce((mx, d) => Math.max(mx, Number(d.sale_date.slice(8, 10))), 0);
  const throughDay = isCurrentMonth ? Number(todayIso.slice(8, 10)) : maxImported;

  const pm = month === 1 ? 12 : month - 1;
  const pmY = month === 1 ? year - 1 : year;
  const cur = aggMtd(branchId, year, month, throughDay);
  const prev = aggMtd(branchId, pmY, pm, throughDay);
  const mtdNett = cur?.nett ?? 0;
  const prevMonthNett = prev?.nett ?? null;
  const lastYearNett = sumNett(branchId, year - 1, month, throughDay);

  // Same-window trend across dimensions (owner 2026-09-20). avg/head guard 0.
  const mtdMetric = (key: string, label: string, kind: "baht" | "int", value: number, prevVal: number | null): MtdMetric =>
    ({ key, label, kind, value: round2(value), prev: prevVal == null ? null : round2(prevVal), pct: relPct(value, prevVal) });
  const trend: MtdMetric[] = cur ? [
    mtdMetric("nett", "ยอดขาย", "baht", cur.nett, prev?.nett ?? null),
    mtdMetric("bills", "จำนวนบิล", "int", cur.bills, prev?.bills ?? null),
    mtdMetric("pax", "ลูกค้า", "int", cur.pax, prev?.pax ?? null),
    mtdMetric("avgBill", "เฉลี่ยต่อบิล", "baht", cur.bills > 0 ? cur.nett / cur.bills : 0, prev && prev.bills > 0 ? prev.nett / prev.bills : null),
    mtdMetric("avgHead", "เฉลี่ยต่อหัว", "baht", cur.pax > 0 ? cur.nett / cur.pax : 0, prev && prev.pax > 0 ? prev.nett / prev.pax : null),
    mtdMetric("discount", "ส่วนลด", "baht", Math.abs(cur.discount), prev == null ? null : Math.abs(prev.discount))
  ] : [];

  return {
    year, month, throughDay,
    mtdNett,
    prevMonthNett,
    prevMonthPct: relPct(mtdNett, prevMonthNett),
    lastYearNett,
    lastYearPct: relPct(mtdNett, lastYearNett),
    trend
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
  const unitsByName = new Map(itemUnitsRange(branchId, start, end).map((u) => [u.name, u.units]));

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
    topItems: attachUnits(items.slice(0, topN), unitsByName),
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
  const unitsByName = new Map(itemUnitsRange(branchId, `${year}-${mm}-01`, end).map((u) => [u.name, u.units]));

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
    topItems: attachUnits(items.slice(0, topN), unitsByName),
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

// ── Annual projection (owner 2026-09-20): full-year target = monthly × 12, vs
// year-to-date sales and a run-rate projection to year end. ──────────────────
export type AnnualProjection = {
  year: number;
  annualTarget: number;   // year-available target (monthly×12, prorated if opened mid-year)
  fullYearTarget: number; // monthly target × 12 (the un-prorated figure, for reference)
  prorated: boolean;      // true when the target was cut to the branch's open span
  openedIso: string | null; // a branch that opened this year: its first-sale date (null for company roll-up / full-year branch)
  ytdNett: number;        // Σ nett, Jan 1 .. throughDate
  pctOfTarget: number;
  projectedNett: number;  // run-rate to Dec 31
  projectedPct: number;
  onTrack: boolean;
  throughDate: string;
  branchCount: number;    // 1 for a branch; N for the company roll-up
};

/** YTD nett + a run-rate projection to year end for ONE branch, based on the
 *  branch's OWN active span (first sale this year → today) — so a branch that
 *  opened mid-year isn't annualised against the whole calendar (owner 2026-09-20). */
function branchYtdProjection(branchId: number, todayIso: string): { ytd: number; projected: number } {
  const y = Number(todayIso.slice(0, 4));
  const rows = listRange(branchId, `${y}-01-01`, todayIso).filter((d) => d.has_sales); // ascending
  const ytd = rows.reduce((s, d) => s + d.nett, 0);
  if (!rows.length) return { ytd: 0, projected: 0 };
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
  const spanDays = Math.max(1, day(todayIso) - day(rows[0].sale_date) + 1);
  const dailyRate = ytd / spanDays;
  const remainingDays = Math.max(0, day(`${y}-12-31`) - day(todayIso));
  return { ytd: round2(ytd), projected: round2(ytd + dailyRate * remainingDays) };
}

const dayNum = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

/** A branch's target for the calendar year. Full year = monthly×12; but a branch
 *  whose authoritative opening date (branches.opens_on) falls within this year is
 *  prorated to its available span (open date → Dec 31), so a store that opened
 *  25/07 isn't judged against a whole-year 7.2M (owner 2026-09-21). */
function branchAnnualTarget(branchId: number, year: number): { annualTarget: number; fullYearTarget: number; openedIso: string | null } | null {
  const monthly = getMonthlyTarget(branchId);
  if (monthly == null || monthly <= 0) return null;
  const fullYearTarget = monthly * 12;
  const jan1 = `${year}-01-01`, dec31 = `${year}-12-31`;
  const opensOn = branchOpensOn(branchId);
  const openedThisYear = opensOn != null && opensOn.slice(0, 4) === String(year) && opensOn > jan1;
  if (!openedThisYear) return { annualTarget: round2(fullYearTarget), fullYearTarget, openedIso: null };
  const yearDays = dayNum(dec31) - dayNum(jan1) + 1;
  const availDays = dayNum(dec31) - dayNum(opensOn as string) + 1;
  return { annualTarget: round2(fullYearTarget * (availDays / yearDays)), fullYearTarget, openedIso: opensOn };
}

function buildAnnual(year: number, t: { annualTarget: number; fullYearTarget: number; openedIso: string | null }, ytd: number, projected: number, todayIso: string, branchCount: number): AnnualProjection | null {
  if (!(t.annualTarget > 0)) return null;
  return {
    year, annualTarget: round2(t.annualTarget), fullYearTarget: round2(t.fullYearTarget),
    prorated: t.annualTarget < t.fullYearTarget - 0.005, openedIso: t.openedIso,
    ytdNett: round2(ytd),
    pctOfTarget: round2((ytd / t.annualTarget) * 100),
    projectedNett: round2(projected),
    projectedPct: round2((projected / t.annualTarget) * 100),
    onTrack: projected >= t.annualTarget,
    throughDate: todayIso, branchCount
  };
}

/** Per-branch annual projection. Null when the branch has no monthly target. */
export function annualProjection(branchId: number, todayIso: string): AnnualProjection | null {
  const y = Number(todayIso.slice(0, 4));
  const t = branchAnnualTarget(branchId, y);
  if (!t) return null;
  const { ytd, projected } = branchYtdProjection(branchId, todayIso);
  return buildAnnual(y, t, ytd, projected, todayIso, 1);
}

/** Company roll-up: project EACH branch on its own active span, then sum — so
 *  branches that opened on different dates aggregate correctly (owner 2026-09-20:
 *  ยอดทั้งปีสองสาขาไม่เท่ากัน ให้คาดการณ์แต่ละสาขาแล้วค่อยรวม). Each branch's annual
 *  target is prorated to its own open span before summing. Only branches with a
 *  target contribute. Scoped to a company's branches by the caller. */
export function annualProjectionForBranches(branchIds: number[], todayIso: string): AnnualProjection | null {
  const y = Number(todayIso.slice(0, 4));
  let annualTarget = 0, fullYearTarget = 0, ytd = 0, projected = 0, n = 0, anyProrated = false;
  for (const id of branchIds) {
    const t = branchAnnualTarget(id, y);
    if (!t) continue;
    const p = branchYtdProjection(id, todayIso);
    annualTarget += t.annualTarget; fullYearTarget += t.fullYearTarget; ytd += p.ytd; projected += p.projected; n++;
    if (t.openedIso) anyProrated = true;
  }
  // Company view: openedIso is per-branch, so leave it null; `prorated` still
  // flags that at least one branch's target was cut to its open span.
  const out = buildAnnual(y, { annualTarget, fullYearTarget, openedIso: null }, ytd, projected, todayIso, n);
  if (out) out.prorated = anyProrated;
  return out;
}

/** Company-wide annual projection — every branch that has a target. */
export function companyAnnualProjection(todayIso: string): AnnualProjection | null {
  return annualProjectionForBranches(branchIdsWithTarget(), todayIso);
}

// ── Company overview (owner 2026-09-21) ──────────────────────────────────────
// Cross-branch roll-up for the ANALYTICA company page: each branch's month-to-
// date sales over ONE shared same-period window (day 1..throughDay), summed to a
// company total and compared to the previous month's identical window; plus the
// company monthly-target progress and the full-year projection roll-up.

export type CompanyBranchRow = {
  branchId: number; branchName: string;
  mtdNett: number; prevSameNett: number | null; momPct: number | null;
  bills: number; pax: number;
  todayNett: number | null;
  monthTarget: number | null; pctOfTarget: number | null; // MTD ÷ full-month target
};
export type CompanyOverview = {
  year: number; month: number; throughDay: number; isCurrentMonth: boolean; branchCount: number;
  total: { mtdNett: number; prevSameNett: number | null; momPct: number | null; bills: number; pax: number; todayNett: number | null };
  target: TargetProgress | null; targetedBranchCount: number;
  annual: AnnualProjection | null;
  branches: CompanyBranchRow[];
};

export function companyOverview(branchIds: number[], year: number, month: number, todayIso: string): CompanyOverview {
  const db = getDb();
  const mm = String(month).padStart(2, "0");
  const isCurrentMonth = todayIso.startsWith(`${year}-${mm}`);

  const brows = branchIds.length
    ? (db.prepare(
        `SELECT id, name, display_order AS ord FROM branches WHERE id IN (${branchIds.map(() => "?").join(",")})`
      ).all(...branchIds) as Array<{ id: number; name: string; ord: number }>)
    : [];
  brows.sort((a, b) => (a.ord - b.ord) || a.name.localeCompare(b.name, "th"));
  const ids = brows.map((b) => b.id);

  // Window: current month → through today; a past month → through the latest day
  // ANY branch imported (matches monthComparison's maxImported so the per-branch
  // page and this page agree, and the prev-month baseline uses the same window).
  let throughDay: number;
  if (isCurrentMonth) throughDay = Number(todayIso.slice(8, 10));
  else if (!ids.length) throughDay = 0;
  else {
    const r = db.prepare(
      `SELECT MAX(sale_date) AS d FROM salesa_daily WHERE has_sales = 1 AND substr(sale_date,1,7) = ? AND branch_id IN (${ids.map(() => "?").join(",")})`
    ).get(`${year}-${mm}`, ...ids) as { d: string | null } | undefined;
    throughDay = r?.d ? Number(r.d.slice(8, 10)) : 0;
  }
  const pm = month === 1 ? 12 : month - 1;
  const pmY = month === 1 ? year - 1 : year;

  const rows: CompanyBranchRow[] = [];
  let tMtd = 0, tBills = 0, tPax = 0, tToday = 0, anyToday = false;
  // Same-store compare: only branches with data in BOTH windows count toward the
  // company MoM %, so a newly-opened branch doesn't inflate the trend.
  let cmpCur = 0, cmpPrev = 0, anyCmp = false;
  let tTargetSum = 0, tMtdTargeted = 0, targetedCount = 0;
  for (const b of brows) {
    const cur = throughDay > 0 ? aggMtd(b.id, year, month, throughDay) : null;
    const prev = throughDay > 0 ? aggMtd(b.id, pmY, pm, throughDay) : null;
    const mtdNett = cur?.nett ?? 0;
    const prevSameNett = prev?.nett ?? null;
    const bills = cur?.bills ?? 0;
    const pax = cur?.pax ?? 0;
    const todayNett = isCurrentMonth
      ? round2(listRange(b.id, todayIso, todayIso).filter((d) => d.has_sales).reduce((s, d) => s + d.nett, 0))
      : null;
    const monthTarget = getMonthlyTarget(b.id);
    const pctOfTarget = monthTarget && monthTarget > 0 ? round2((mtdNett / monthTarget) * 100) : null;
    rows.push({ branchId: b.id, branchName: b.name, mtdNett, prevSameNett, momPct: relPct(mtdNett, prevSameNett), bills, pax, todayNett, monthTarget, pctOfTarget });
    tMtd += mtdNett; tBills += bills; tPax += pax;
    if (cur && prev) { cmpCur += cur.nett; cmpPrev += prev.nett; anyCmp = true; }
    if (todayNett != null) { tToday += todayNett; anyToday = true; }
    if (monthTarget && monthTarget > 0) { tTargetSum += monthTarget; tMtdTargeted += mtdNett; targetedCount++; }
  }

  const total = {
    mtdNett: round2(tMtd),
    prevSameNett: anyCmp ? round2(cmpPrev) : null,   // comparable (same-store) prev
    momPct: anyCmp ? relPct(cmpCur, cmpPrev) : null, // comparable current vs prev
    bills: tBills, pax: tPax,
    todayNett: isCurrentMonth ? round2(anyToday ? tToday : 0) : null
  };
  const target = tTargetSum > 0 ? targetProgress(tTargetSum, tMtdTargeted, throughDay, year, month) : null;
  // Annual roll-up only makes sense for the current year (it's a YTD + run-rate
  // projection). Browsing a past year → no annual card, not stale current-year.
  const annual = year === Number(todayIso.slice(0, 4)) ? annualProjectionForBranches(ids, todayIso) : null;
  return { year, month, throughDay, isCurrentMonth, branchCount: brows.length, total, target, targetedBranchCount: targetedCount, annual, branches: rows };
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

// ── Range helpers (owner 2026-09-18): the same insights over a month OR an ISO
// week. Public month wrappers stay; a range core does the work so the dashboard
// can toggle สัปดาห์/เดือน. ────────────────────────────────────────────────────
function monthRange(year: number, month: number): [string, string] {
  const mm = String(month).padStart(2, "0");
  return [`${year}-${mm}-01`, `${year}-${mm}-${String(daysInMonth(year, month)).padStart(2, "0")}`];
}
function prevMonthRange(year: number, month: number): [string, string] {
  const pm = month === 1 ? 12 : month - 1;
  const pmY = month === 1 ? year - 1 : year;
  return monthRange(pmY, pm);
}
function salesRows(branchId: number, start: string, end: string): DailyRow[] {
  return listRange(branchId, start, end).filter((d) => d.has_sales);
}

/** Discount ROI signal (owner D): does heavier discounting move sales? Split
 *  days by median discount% and compare average nett. */
function rangeDiscountInsight(branchId: number, start: string, end: string): DiscountInsight {
  const rows = salesRows(branchId, start, end).filter((d) => d.gross > 0);
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
export function discountInsight(branchId: number, year: number, month: number): DiscountInsight {
  const [s, e] = monthRange(year, month);
  return rangeDiscountInsight(branchId, s, e);
}

export type ChannelSlice = { name: string; sales: number; qty: number; pct: number; avgTicket: number | null };
export type ChannelMix = { types: ChannelSlice[]; payments: ChannelSlice[]; sources: ChannelSlice[] };

/** Aggregate order types / payment methods / sources over a range, with each
 *  slice's share of the total (owner E). */
function rangeChannelMix(branchId: number, start: string, end: string): ChannelMix {
  const rows = salesRows(branchId, start, end);
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
export function monthChannelMix(branchId: number, year: number, month: number): ChannelMix {
  const [s, e] = monthRange(year, month);
  return rangeChannelMix(branchId, s, e);
}

// ── Deeper marketing insights (owner 2026-09-18: เอาหมดเลย) ──────────────────

// #1 Menu engineering — classify menus by revenue (high/low vs median) × momentum
// (rising/falling vs the previous period). Star / Plowhorse / Puzzle / Dog.
// units = จำนวนจานที่ขาย (owner 2026-09-19), joined from receipt data by name;
// null when there's no receipt match (the revenue-only overview file has no unit
// count). Shown alongside nett.
export type MenuClass = { name: string; nett: number; units: number | null; deltaPct: number | null; isNew: boolean };
export type MenuEngineering = {
  stars: MenuClass[];        // high revenue + rising
  plowhorses: MenuClass[];   // high revenue + flat/falling
  puzzles: MenuClass[];      // low revenue + rising
  dogs: MenuClass[];         // low revenue + falling
  medianNett: number;
};
function rangeMenuEngineering(branchId: number, start: string, end: string, prevStart: string, prevEnd: string, topN = 6): MenuEngineering {
  const items = menuRange(branchId, start, end, "item");
  const prev = new Map(menuRange(branchId, prevStart, prevEnd, "item").map((m) => [m.name, m.nett]));
  if (!items.length) return { stars: [], plowhorses: [], puzzles: [], dogs: [], medianNett: 0 };
  // จำนวนจาน per menu from receipt data (by name). Null when no receipt match.
  const unitsByName = new Map(itemUnitsRange(branchId, start, end).map((u) => [u.name, u.units]));
  const sorted = [...items].map((m) => m.nett).sort((a, b) => a - b);
  const medianNett = sorted[Math.floor(sorted.length / 2)];
  const classed: MenuClass[] = items.map((m) => {
    const isNew = !prev.has(m.name);
    return { name: m.name, nett: m.nett, units: unitsByName.get(m.name) ?? null, isNew, deltaPct: isNew ? null : relPct(m.nett, prev.get(m.name) ?? 0) };
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
export function menuEngineering(branchId: number, year: number, month: number, topN = 6): MenuEngineering {
  const [s, e] = monthRange(year, month);
  const [ps, pe] = prevMonthRange(year, month);
  return rangeMenuEngineering(branchId, s, e, ps, pe, topN);
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
function rangeBeverageMix(branchId: number, start: string, end: string): BeverageMix {
  const cats = menuRange(branchId, start, end, "category");
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
export function beverageMix(branchId: number, year: number, month: number): BeverageMix {
  const [s, e] = monthRange(year, month);
  return rangeBeverageMix(branchId, s, e);
}

// #7 Revenue concentration (80/20) over the range's menus.
export type MenuConcentration = { itemCount: number; total: number; top5Pct: number | null; countFor80: number };
function rangeMenuConcentration(branchId: number, start: string, end: string): MenuConcentration {
  const items = menuRange(branchId, start, end, "item"); // already sorted desc
  const total = round2(items.reduce((s, m) => s + m.nett, 0));
  if (!items.length || total <= 0) return { itemCount: items.length, total, top5Pct: null, countFor80: 0 };
  const top5 = items.slice(0, 5).reduce((s, m) => s + m.nett, 0);
  let cum = 0, countFor80 = 0;
  for (const m of items) { cum += m.nett; countFor80++; if (cum / total >= 0.8) break; }
  return { itemCount: items.length, total, top5Pct: round2((top5 / total) * 100), countFor80 };
}
export function menuConcentration(branchId: number, year: number, month: number): MenuConcentration {
  const [s, e] = monthRange(year, month);
  return rangeMenuConcentration(branchId, s, e);
}

// #3 Guest metrics — party size (heads/bill) + spend per head, vs prev period.
export type GuestMetrics = {
  avgPartySize: number | null; avgSpendPerHead: number | null;
  prevPartySize: number | null; partyMomPct: number | null;
  prevSpendPerHead: number | null; spendMomPct: number | null;
};
function rangeTotals(branchId: number, start: string, end: string): { nett: number; bills: number; pax: number; days: number } {
  const rows = salesRows(branchId, start, end);
  return { nett: rows.reduce((s, d) => s + d.nett, 0), bills: rows.reduce((s, d) => s + d.bill_count, 0), pax: rows.reduce((s, d) => s + d.pax, 0), days: rows.length };
}
function rangeGuestMetrics(branchId: number, start: string, end: string, prevStart: string, prevEnd: string): GuestMetrics {
  const t = rangeTotals(branchId, start, end);
  const p = rangeTotals(branchId, prevStart, prevEnd);
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
export function guestMetrics(branchId: number, year: number, month: number): GuestMetrics {
  const [s, e] = monthRange(year, month);
  const [ps, pe] = prevMonthRange(year, month);
  return rangeGuestMetrics(branchId, s, e, ps, pe);
}

// #5 Payday / weekend effect within the range.
export type RhythmInsight = {
  paydayAvgNett: number | null; otherAvgNett: number | null; paydayLiftPct: number | null; paydayDays: number;
  weekendAvgNett: number | null; weekdayAvgNett: number | null; weekendLiftPct: number | null;
};
function rangeRhythm(branchId: number, start: string, end: string): RhythmInsight {
  const rows = salesRows(branchId, start, end);
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
export function rhythmInsight(branchId: number, year: number, month: number): RhythmInsight {
  const [s, e] = monthRange(year, month);
  return rangeRhythm(branchId, s, e);
}

// #6 Void / refund quality signal, with the prev period's void rate.
export type QualitySignal = {
  voidAmount: number; voidBillCount: number; refund: number;
  voidRatePct: number | null;      // void amount / gross
  voidBillRatePct: number | null;  // void bills / bills
  prevVoidRatePct: number | null;
  flag: boolean;                   // void rate above threshold
};
function rangeQualitySignal(branchId: number, start: string, end: string, prevStart: string, prevEnd: string): QualitySignal {
  const rows = salesRows(branchId, start, end);
  const sum = (get: (d: DailyRow) => number, arr: DailyRow[]) => arr.reduce((s, d) => s + get(d), 0);
  const gross = sum((d) => d.gross, rows);
  const bills = sum((d) => d.bill_count, rows);
  const voidAmount = round2(sum((d) => d.void_amount, rows));
  const voidRate = gross > 0 ? round2((voidAmount / gross) * 100) : null;
  const prevRows = salesRows(branchId, prevStart, prevEnd);
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
export function qualitySignal(branchId: number, year: number, month: number): QualitySignal {
  const [s, e] = monthRange(year, month);
  const [ps, pe] = prevMonthRange(year, month);
  return rangeQualitySignal(branchId, s, e, ps, pe);
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

function rangeReceiptInsights(branchId: number, start: string, end: string, topN = 8): ReceiptInsights {
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
export function receiptInsights(branchId: number, year: number, month: number, topN = 8): ReceiptInsights {
  const [s, e] = monthRange(year, month);
  return rangeReceiptInsights(branchId, s, e, topN);
}

// ── Period bundle (owner 2026-09-18): all range-based insight panels for one
// period (this month or the current ISO week), so the dashboard can toggle. ──
export type InsightPeriod = "month" | "week";
export type InsightRange = {
  period: InsightPeriod;
  start: string; end: string;
  prevStart: string; prevEnd: string;
  rangeLabel: string;   // e.g. "15 กันยายน 2569 – 21 กันยายน 2569"
  prevLabel: string;    // "เทียบเดือนก่อน" | "เทียบสัปดาห์ก่อน"
  nowLabel: string;     // "เดือนนี้" | "สัปดาห์นี้"
};
export type InsightBundle = {
  range: InsightRange;
  channels: ChannelMix;
  discount: DiscountInsight;
  menuEngineering: MenuEngineering;
  beverage: BeverageMix;
  concentration: MenuConcentration;
  guests: GuestMetrics;
  rhythm: RhythmInsight;
  quality: QualitySignal;
  receipt: ReceiptInsights;
};

/** Resolve the date range for a period. `todayIso` anchors the current ISO week;
 *  for month, `year`/`month` name the viewed month. */
export function insightRangeFor(period: InsightPeriod, year: number, month: number, todayIso: string): InsightRange {
  if (period === "week") {
    const monday = mondayOf(todayIso);
    const sunday = addDaysIso(monday, 6);
    return {
      period, start: monday, end: sunday,
      prevStart: addDaysIso(monday, -7), prevEnd: addDaysIso(monday, -1),
      rangeLabel: `${thaiDate(monday)} – ${thaiDate(sunday)}`,
      prevLabel: "เทียบสัปดาห์ก่อน", nowLabel: "สัปดาห์นี้"
    };
  }
  // Same-period month comparison (owner 2026-09-20): compare day 1..N of this
  // month against day 1..N of last month — so a partial current month is never
  // measured against a FULL previous month. N = today (current month), or the
  // month's own last day when reviewing a completed month. This makes every
  // "vs เดือนก่อน" panel (menu momentum, guests, quality) apples-to-apples.
  const mm = String(month).padStart(2, "0");
  const isCurrent = todayIso.startsWith(`${year}-${mm}`);
  const throughDay = isCurrent ? Number(todayIso.slice(8, 10)) : daysInMonth(year, month);
  const pm = month === 1 ? 12 : month - 1;
  const pmY = month === 1 ? year - 1 : year;
  const pmm = String(pm).padStart(2, "0");
  const s = `${year}-${mm}-01`;
  const e = `${year}-${mm}-${String(Math.min(throughDay, daysInMonth(year, month))).padStart(2, "0")}`;
  const ps = `${pmY}-${pmm}-01`;
  const pe = `${pmY}-${pmm}-${String(Math.min(throughDay, daysInMonth(pmY, pm))).padStart(2, "0")}`;
  return { period, start: s, end: e, prevStart: ps, prevEnd: pe, rangeLabel: roundLabel(s, e), prevLabel: "เทียบเดือนก่อน", nowLabel: "เดือนนี้" };
}

export function insightBundle(branchId: number, r: InsightRange): InsightBundle {
  return {
    range: r,
    channels: rangeChannelMix(branchId, r.start, r.end),
    discount: rangeDiscountInsight(branchId, r.start, r.end),
    menuEngineering: rangeMenuEngineering(branchId, r.start, r.end, r.prevStart, r.prevEnd),
    beverage: rangeBeverageMix(branchId, r.start, r.end),
    concentration: rangeMenuConcentration(branchId, r.start, r.end),
    guests: rangeGuestMetrics(branchId, r.start, r.end, r.prevStart, r.prevEnd),
    rhythm: rangeRhythm(branchId, r.start, r.end),
    quality: rangeQualitySignal(branchId, r.start, r.end, r.prevStart, r.prevEnd),
    receipt: rangeReceiptInsights(branchId, r.start, r.end)
  };
}

// ── Festival / important-day analysis (owner 2026-09-20) ─────────────────────
// Cross-branch: for each public-holiday date in a year, each POS branch's sales
// that day vs the branch's average daily sales that month (uplift %) — so the
// owner can plan next year's festivals per branch. Only past dates (<= today)
// with at least one branch's sales appear.

export type FestivalBranchCell = {
  branchId: number; branchName: string;
  sales: number | null;      // that day's nett (null = no data)
  monthAvg: number | null;   // avg daily nett that month (excl. the day itself)
  upliftPct: number | null;  // (sales − monthAvg) / monthAvg × 100
};
export type FestivalRow = { date: string; dateLabel: string; nameTh: string; branches: FestivalBranchCell[] };
export type FestivalAnalysis = { year: number; branches: Array<{ id: number; name: string }>; rows: FestivalRow[] };

/** Branches that recorded sales in `yr` (year-scoped, has_sales & nett>0), sorted
 *  by display order, optionally restricted to allowedBranchIds. Shared by the
 *  cross-branch year panels (festival + growth bars) so the two never diverge. */
function branchesWithSalesInYear(yr: string, allowedBranchIds?: number[] | null): Array<{ id: number; name: string }> {
  let branches = (getDb().prepare(`
    SELECT DISTINCT d.branch_id AS id, b.name AS name, b.display_order AS ord
    FROM salesa_daily d JOIN branches b ON b.id = d.branch_id
    WHERE substr(d.sale_date, 1, 4) = ? AND d.has_sales = 1 AND d.nett > 0
  `).all(yr) as Array<{ id: number; name: string; ord: number }>)
    .sort((a, b) => (a.ord - b.ord) || a.name.localeCompare(b.name, "th"))
    .map((b) => ({ id: b.id, name: b.name }));
  if (allowedBranchIds && allowedBranchIds.length) {
    const allow = new Set(allowedBranchIds);
    branches = branches.filter((b) => allow.has(b.id));
  }
  return branches;
}

export function festivalAnalysis(year: number, todayIso: string, allowedBranchIds?: number[] | null): FestivalAnalysis {
  const db = getDb();
  const yr = String(year);

  // Branches that have SALESA data IN THIS YEAR, optionally restricted to what
  // the caller may see (a per-branch admin only sees their own; super_admin sees
  // all). Year-scoping keeps decommissioned/other-year branches out of the table.
  const branches = branchesWithSalesInYear(yr, allowedBranchIds);
  if (!branches.length) return { year, branches: [], rows: [] };

  const holidays = db.prepare(
    "SELECT date, name_th FROM public_holidays WHERE substr(date, 1, 4) = ? ORDER BY date"
  ).all(yr) as Array<{ date: string; name_th: string }>;

  // Pull only the branches we'll actually render (small droplet — avoid loading
  // every branch's year of dailies just to discard them for a per-branch admin).
  const bids = branches.map((b) => b.id);
  const daily = db.prepare(`
    SELECT branch_id AS b, sale_date AS d, nett AS n
    FROM salesa_daily
    WHERE substr(sale_date, 1, 4) = ? AND has_sales = 1 AND nett > 0
      AND branch_id IN (${bids.map(() => "?").join(",")})
  `).all(yr, ...bids) as Array<{ b: number; d: string; n: number }>;
  const byBranchDate = new Map<string, number>();
  const byBranchMonth = new Map<string, Array<{ d: string; n: number }>>();
  for (const r of daily) {
    byBranchDate.set(`${r.b}:${r.d}`, r.n);
    const mk = `${r.b}:${r.d.slice(0, 7)}`;
    const arr = byBranchMonth.get(mk) ?? []; arr.push({ d: r.d, n: r.n }); byBranchMonth.set(mk, arr);
  }

  const rows: FestivalRow[] = [];
  for (const h of holidays) {
    if (h.date > todayIso) continue; // future festival — no sales yet
    const cells: FestivalBranchCell[] = branches.map((br) => {
      const sales = byBranchDate.get(`${br.id}:${h.date}`) ?? null;
      const monthDays = (byBranchMonth.get(`${br.id}:${h.date.slice(0, 7)}`) ?? []).filter((x) => x.d !== h.date);
      const monthAvg = monthDays.length ? monthDays.reduce((s, x) => s + x.n, 0) / monthDays.length : null;
      const upliftPct = (sales != null && monthAvg != null && monthAvg > 0)
        ? Math.round(((sales - monthAvg) / monthAvg) * 1000) / 10 : null;
      return { branchId: br.id, branchName: br.name, sales, monthAvg: monthAvg != null ? round2(monthAvg) : null, upliftPct };
    });
    if (cells.some((c) => c.sales != null)) {
      rows.push({ date: h.date, dateLabel: thaiDate(h.date), nameTh: h.name_th, branches: cells });
    }
  }
  return { year, branches, rows };
}

// ── Full-year growth bars (owner 2026-09-21) ─────────────────────────────────
// Per branch, monthly nett across the year (Jan → the last month with data), so
// the owner can see each branch's growth trend once a full year is imported.
// Cross-branch (super_admin) or the active branch only.

export type BranchYearBars = {
  branchId: number; branchName: string;
  months: Array<number | null>; // index 0..monthCount-1 = Jan.. ; null = no data that month
  total: number;
  growthPct: number | null;     // first month with data → last month with data
  peakMonth: number | null;     // 1..12 of the biggest month
};
export type AnnualBranchBars = { year: number; monthCount: number; branches: BranchYearBars[] };

export function annualBranchBars(year: number, todayIso: string, allowedBranchIds?: number[] | null): AnnualBranchBars {
  const db = getDb();
  const yr = String(year);

  const branches = branchesWithSalesInYear(yr, allowedBranchIds);
  // Render Jan..Dec for a past year; only through the current month for this year.
  const isThisYear = year === Number(todayIso.slice(0, 4));
  const monthCount = isThisYear ? Number(todayIso.slice(5, 7)) : 12;
  // Growth % ignores the in-progress current month (it's a partial figure that
  // would read spuriously low) — compare only fully-elapsed months.
  const completeUpTo = isThisYear ? Math.max(0, monthCount - 1) : monthCount;
  if (!branches.length) return { year, monthCount, branches: [] };

  const bids = branches.map((b) => b.id);
  const rows = db.prepare(`
    SELECT branch_id AS b, substr(sale_date, 6, 2) AS m, SUM(nett) AS n
    FROM salesa_daily
    WHERE substr(sale_date, 1, 4) = ? AND has_sales = 1 AND nett > 0
      AND branch_id IN (${bids.map(() => "?").join(",")})
    GROUP BY branch_id, m
  `).all(yr, ...bids) as Array<{ b: number; m: string; n: number }>;
  const byBranchMonth = new Map<number, number>(); // key = branchId*100 + monthIdx
  for (const r of rows) {
    const idx = Number(r.m) - 1;
    if (idx >= 0 && idx < monthCount) byBranchMonth.set(r.b * 100 + idx, round2(r.n));
  }

  const out: BranchYearBars[] = branches.map((br) => {
    const months: Array<number | null> = [];
    for (let i = 0; i < monthCount; i++) months.push(byBranchMonth.has(br.id * 100 + i) ? (byBranchMonth.get(br.id * 100 + i) as number) : null);
    const active = months.map((v, i) => ({ v, i })).filter((x) => x.v != null) as Array<{ v: number; i: number }>;
    const total = round2(active.reduce((s, x) => s + x.v, 0));
    // Growth compares the first vs last month with data among fully-elapsed
    // months only (drops the in-progress current month).
    const gActive = active.filter((x) => x.i < completeUpTo);
    const gFirst = gActive[0], gLast = gActive[gActive.length - 1];
    const growthPct = gActive.length >= 2 && gFirst.v > 0 ? Math.round(((gLast.v - gFirst.v) / gFirst.v) * 1000) / 10 : null;
    const peak = active.reduce<{ v: number; i: number } | null>((best, x) => (!best || x.v > best.v ? x : best), null);
    return { branchId: br.id, branchName: br.name, months, total, growthPct, peakMonth: peak ? peak.i + 1 : null };
  }).filter((b) => b.total > 0);

  return { year, monthCount, branches: out };
}
