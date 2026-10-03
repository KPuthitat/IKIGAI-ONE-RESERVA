// Visit-pattern engine (owner 2026-10-03) — shared by ANALYTICA's corporate
// customers (tax invoices) and INSIGNA's members (linked POS bills). Given a
// customer's visits (date + amount), answers: how often they come, how many
// times this year, which part of the month and weekday they tend to come,
// whether visits cluster near a public holiday, spend so far, and whether
// they have gone quiet. Pure — the caller supplies the holidays.

import { thaiDate } from "./revshare";

const TH_WEEKDAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const DAY_MS = 86_400_000;
export const HOLIDAY_WINDOW_DAYS = 3;     // a visit within ±3 days of a public holiday counts as "near" it

export type MonthPhase = "early" | "mid" | "late";
export const PHASE_TH: Record<MonthPhase, string> = { early: "ต้นเดือน", mid: "กลางเดือน", late: "ปลายเดือน" };

export type Visit = { date: string; total: number };
export type Holiday = { day: number; name: string };   // day = days since epoch

export type VisitPattern = {
  visits: number;                     // all time
  spend: number;
  visitsYear: number;                 // the viewed year
  spendYear: number;
  avgPerVisit: number | null;         // this year's, else all-time
  perMonth: number | null;            // visits per covered month this year
  cadence: string;                    // "เดือนละ ~2 ครั้ง" / "ทุก ~2 เดือน" / "มาครั้งเดียว" / "ปีนี้ยังไม่มา"
  avgGapDays: number | null;          // mean days between consecutive visits (all time)
  firstVisit: string;
  lastVisit: string;
  lastVisitLabel: string;
  daysSinceLast: number;
  overdue: boolean;                   // quiet for longer than 1.5× their usual gap (and over 3 weeks)
  months: number[];                   // 12 cells — visits per month of the viewed year
  phase: { key: MonthPhase; label: string; count: number } | null;   // most common part of the month (year)
  phaseCounts: Record<MonthPhase, number>;
  weekday: { dow: number; label: string; count: number } | null;    // most common weekday (year)
  nearHoliday: { count: number; names: string[] };                   // visits within ±3 days of a holiday (year)
};

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const dayNum = (iso: string) => Math.floor(new Date(`${iso}T00:00:00Z`).getTime() / DAY_MS);
const dowOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

export function phaseOf(iso: string): MonthPhase {
  const dom = Number(iso.slice(8, 10));
  return dom <= 10 ? "early" : dom <= 20 ? "mid" : "late";
}

function modeOf<K>(counts: Map<K, number>): { key: K; count: number } | null {
  let best: { key: K; count: number } | null = null;
  for (const [key, count] of counts) if (!best || count > best.count) best = { key, count };
  return best;
}

/** Half-step rounding for the cadence wording: 0.9 → "เดือนละ ~1 ครั้ง",
 *  1.3 → "~1.5", 2.1 → "~2" — a decimal like 0.9 reads oddly for a person. */
const half = (n: number) => String(Math.max(0.5, Math.round(n * 2) / 2));

export function cadenceLabel(visitsYear: number, perMonth: number | null): string {
  if (visitsYear === 0) return "ปีนี้ยังไม่มา";
  if (visitsYear === 1 || perMonth == null) return "มาครั้งเดียว";
  if (perMonth >= 0.8) return `เดือนละ ~${half(perMonth)} ครั้ง`;
  return `ทุก ~${half(1 / perMonth)} เดือน`;
}

/** Months of the year the data covers, from the first date with data (or
 *  Jan 1) to today (or Dec 31), in 30.44-day months — the denominator for
 *  "เดือนละกี่ครั้ง". */
export function monthsCovered(year: number, coverageFrom: string | null, todayIso: string): number {
  const yStart = `${year}-01-01`, yEnd = `${year}-12-31`;
  const from = coverageFrom && coverageFrom > yStart ? coverageFrom : yStart;
  const to = todayIso < yEnd ? todayIso : yEnd;
  return Math.max(0.5, (dayNum(to) - dayNum(from) + 1) / 30.44);
}

/** Compute one customer's pattern. `visits` may be in any order; two visits on
 *  the same day count as separate visits unless the caller merged them. */
export function visitPattern(visitsIn: Visit[], opts: { year: number; todayIso: string; monthsCovered: number; holidays: Holiday[] }): VisitPattern {
  const list = [...visitsIn].sort((a, b) => a.date.localeCompare(b.date));
  const { year, todayIso, holidays } = opts;
  const latest = list[list.length - 1];
  const visits = list.length;
  const spend = round2(list.reduce((s, v) => s + v.total, 0));
  const inYear = list.filter((v) => v.date.startsWith(`${year}-`));
  const visitsYear = inYear.length;
  const spendYear = round2(inYear.reduce((s, v) => s + v.total, 0));
  const avgPerVisit = visitsYear > 0 ? round2(spendYear / visitsYear) : visits > 0 ? round2(spend / visits) : null;
  const perMonth = visitsYear > 0 ? round2(visitsYear / opts.monthsCovered) : null;

  const visitDays = [...new Set(list.map((v) => v.date))].map(dayNum);
  let avgGapDays: number | null = null;
  if (visitDays.length >= 2) {
    let sum = 0;
    for (let i = 1; i < visitDays.length; i++) sum += visitDays[i] - visitDays[i - 1];
    avgGapDays = Math.round(sum / (visitDays.length - 1));
  }
  const daysSinceLast = dayNum(todayIso) - dayNum(latest.date);
  const overdue = avgGapDays != null && daysSinceLast > Math.max(avgGapDays * 1.5, 21);

  const months = Array<number>(12).fill(0);
  const phaseCounts = new Map<MonthPhase, number>();
  const dowCounts = new Map<number, number>();
  let nearCount = 0;
  const nearNames = new Set<string>();
  for (const v of inYear) {
    months[Number(v.date.slice(5, 7)) - 1]++;
    const ph = phaseOf(v.date);
    phaseCounts.set(ph, (phaseCounts.get(ph) ?? 0) + 1);
    const dw = dowOf(v.date);
    dowCounts.set(dw, (dowCounts.get(dw) ?? 0) + 1);
    const d = dayNum(v.date);
    let nearest: { name: string; dist: number } | null = null;
    for (const h of holidays) {
      const dist = Math.abs(h.day - d);
      if (dist <= HOLIDAY_WINDOW_DAYS && (!nearest || dist < nearest.dist)) nearest = { name: h.name, dist };
    }
    if (nearest) { nearCount++; nearNames.add(nearest.name); }
  }
  const phaseMode = modeOf(phaseCounts);
  const dowMode = modeOf(dowCounts);
  return {
    visits, spend, visitsYear, spendYear, avgPerVisit, perMonth, cadence: cadenceLabel(visitsYear, perMonth), avgGapDays,
    firstVisit: list[0].date, lastVisit: latest.date, lastVisitLabel: thaiDate(latest.date), daysSinceLast, overdue,
    months,
    phase: phaseMode ? { key: phaseMode.key, label: PHASE_TH[phaseMode.key], count: phaseMode.count } : null,
    phaseCounts: { early: phaseCounts.get("early") ?? 0, mid: phaseCounts.get("mid") ?? 0, late: phaseCounts.get("late") ?? 0 },
    weekday: dowMode ? { dow: dowMode.key, label: TH_WEEKDAYS[dowMode.key], count: dowMode.count } : null,
    nearHoliday: { count: nearCount, names: [...nearNames] }
  };
}
