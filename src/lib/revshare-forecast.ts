// Whole-month sales estimate for a revenue-share partner's shop (owner 2026-10-06:
// ขอยอดคาดการณ์ทั้งเดือนของจ้อจี้ แต่ไม่ต้องส่งในรายงาน). Display-only: nothing here
// feeds the settlement, the invoice or any LINE card.
//
// Method: actual imported sales this month + an estimate for every still-OPEN day
// left in the month. A day's estimate is the mean of the same weekday's sales
// (days with sales only) over the history window; a weekday with no history falls
// back to the overall daily mean. Closed weekdays are skipped. No holiday or
// weather adjustment — it is a run-rate, not a prediction of special days.

export type DailySales = { date: string; sales: number };   // date = YYYY-MM-DD (BKK)

export type MonthSalesForecast = {
  actual: number;               // imported sales so far this month
  actualDays: number;           // days with an import this month
  lastDate: string | null;      // latest imported day this month
  remainingDays: number;        // open days still to come (not yet imported)
  remainingEstimate: number;    // estimated sales for those days
  total: number;                // actual + remainingEstimate
  basisDays: number;            // history days the weekday averages came from
  method: "weekday" | "overall";
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function projectMonthSales(args: {
  year: number; month: number;                 // the month being viewed (1-12)
  history: DailySales[];                       // imported days: the lookback window AND this month's rows
  closedWeekdays?: number[];                   // 0 = Sunday … 6 = Saturday
}): MonthSalesForecast | null {
  const { year, month, history, closedWeekdays = [] } = args;
  const mm = String(month).padStart(2, "0");
  const monthStart = `${year}-${mm}-01`;
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthEnd = `${year}-${mm}-${String(dim).padStart(2, "0")}`;

  const days = history.filter((h) => h.sales > 0);
  if (days.length === 0) return null;
  const inMonth = history.filter((h) => h.date >= monthStart && h.date <= monthEnd);
  const actual = round2(inMonth.reduce((s, h) => s + h.sales, 0));
  const lastDate = inMonth.length ? inMonth.reduce((m, h) => (h.date > m ? h.date : m), inMonth[0].date) : null;

  // Weekday means (and the overall mean as the fallback).
  const byDow = new Map<number, number[]>();
  for (const h of days) {
    const k = dow(h.date);
    byDow.set(k, [...(byDow.get(k) ?? []), h.sales]);
  }
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const overall = mean(days.map((h) => h.sales));

  let remainingEstimate = 0, remainingDays = 0, usedFallback = false;
  for (let d = addDays(lastDate ?? addDays(monthStart, -1), 1); d <= monthEnd; d = addDays(d, 1)) {
    const k = dow(d);
    if (closedWeekdays.includes(k)) continue;
    const xs = byDow.get(k);
    if (xs && xs.length) remainingEstimate += mean(xs);
    else { remainingEstimate += overall; usedFallback = true; }
    remainingDays++;
  }
  remainingEstimate = round2(remainingEstimate);
  return {
    actual, actualDays: inMonth.length, lastDate,
    remainingDays, remainingEstimate,
    total: round2(actual + remainingEstimate),
    basisDays: days.length,
    method: usedFallback ? "overall" : "weekday"
  };
}

// ── Partner shop vs the whole restaurant (owner 2026-10-10) ───────────────────
// "ยอดขายจ้อจี้เป็นกี่ % ของยอดขายร้าน" per day, month to date and for the forecast
// month. Both sides are VAT-inclusive totals (the partner side is converted by the
// caller; the restaurant side is the POS "Total Sales"). Days count only when BOTH
// sides have data, so a missing import never skews the percentage.

export type ShopShare = {
  perDay: Record<string, number>;      // date → partner ÷ restaurant × 100 (days with both)
  latest: { date: string; pct: number; partner: number; shop: number } | null;
  cumulative: { pct: number; partner: number; shop: number; days: number } | null;
  forecast: { pct: number; partner: number; shop: number } | null;
};

export function shopShareStats(args: {
  partnerDaily: DailySales[];          // VAT-inclusive
  shopDaily: DailySales[];
  partnerForecastTotal?: number | null;   // VAT-inclusive whole-month estimates
  shopForecastTotal?: number | null;
}): ShopShare {
  const shop = new Map(args.shopDaily.filter((d) => d.sales > 0).map((d) => [d.date, d.sales]));
  const perDay: Record<string, number> = {};
  let sp = 0, ss = 0, days = 0, latest: ShopShare["latest"] = null;
  for (const p of [...args.partnerDaily].sort((a, b) => a.date.localeCompare(b.date))) {
    const s = shop.get(p.date);
    if (!s || p.sales < 0) continue;
    perDay[p.date] = round2((p.sales / s) * 100);
    sp += p.sales; ss += s; days++;
    latest = { date: p.date, pct: perDay[p.date], partner: round2(p.sales), shop: round2(s) };
  }
  const fp = args.partnerForecastTotal, fs = args.shopForecastTotal;
  return {
    perDay, latest,
    cumulative: days > 0 ? { pct: round2((sp / ss) * 100), partner: round2(sp), shop: round2(ss), days } : null,
    forecast: fp != null && fs != null && fs > 0 ? { pct: round2((fp / fs) * 100), partner: round2(fp), shop: round2(fs) } : null
  };
}
