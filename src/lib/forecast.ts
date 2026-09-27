// ANALYTICA forward plan (owner 2026-09-27): predict the next few days' sales
// from each weekday's trailing average × recent momentum, flag Thai public
// holidays and pay-day windows, and hand the team a น้องฮูก suggestion per day.
// Restaurant-focused (นามะ/ไฮโป); a clinic gets a lighter version. Weather is
// folded in separately (best-effort) by the API layer via `attachWeather`.

import { getDb } from "./db";
import { listRange } from "./salesa-db";
import { isClinicaBranch, clinicaDailyNetRange } from "./clinica-db";
import { fetchBranchWeather } from "./weather";
import { eventNotesByDate } from "./event-notes";

function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }
function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const TH_WEEKDAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

// Thai public holidays — fixed national dates for 2026–2027 plus the commonly
// published Buddhist (lunar) dates. Flagged only (no auto-multiplier), so a
// slightly-off lunar date is low-risk; the team reads it as context.
const THAI_HOLIDAYS: Record<string, string> = {
  "2026-01-01": "วันขึ้นปีใหม่",
  "2026-03-03": "วันมาฆบูชา",
  "2026-04-06": "วันจักรี",
  "2026-04-13": "วันสงกรานต์",
  "2026-04-14": "วันสงกรานต์",
  "2026-04-15": "วันสงกรานต์",
  "2026-05-01": "วันแรงงาน",
  "2026-05-04": "วันฉัตรมงคล",
  "2026-05-31": "วันวิสาขบูชา",
  "2026-06-03": "วันเฉลิมฯ พระราชินี",
  "2026-07-28": "วันเฉลิมฯ ร.10",
  "2026-07-29": "วันอาสาฬหบูชา",
  "2026-07-30": "วันเข้าพรรษา",
  "2026-08-12": "วันแม่แห่งชาติ",
  "2026-10-13": "วันคล้ายวันสวรรคต ร.9",
  "2026-10-23": "วันปิยมหาราช",
  "2026-12-05": "วันพ่อแห่งชาติ",
  "2026-12-10": "วันรัฐธรรมนูญ",
  "2026-12-31": "วันสิ้นปี",
  "2027-01-01": "วันขึ้นปีใหม่",
  "2027-02-21": "วันมาฆบูชา",
  "2027-04-06": "วันจักรี",
  "2027-04-13": "วันสงกรานต์",
  "2027-04-14": "วันสงกรานต์",
  "2027-04-15": "วันสงกรานต์",
  "2027-05-01": "วันแรงงาน",
  "2027-05-20": "วันวิสาขบูชา",
  "2027-07-28": "วันเฉลิมฯ ร.10",
  "2027-08-12": "วันแม่แห่งชาติ",
  "2027-10-13": "วันคล้ายวันสวรรคต ร.9",
  "2027-10-23": "วันปิยมหาราช",
  "2027-12-05": "วันพ่อแห่งชาติ",
  "2027-12-10": "วันรัฐธรรมนูญ",
  "2027-12-31": "วันสิ้นปี",
};
export function holidayOn(iso: string): string | null { return THAI_HOLIDAYS[iso] ?? null; }

export type ForecastWeather = { tempMax: number | null; tempMin: number | null; rainChance: number | null; summary: string };
export type ForecastDay = {
  date: string; dow: number; dowLabel: string; closed: boolean;
  weekdayAvg: number;               // trailing average for this weekday (0 = no history)
  predictedNett: number | null;     // weekdayAvg × momentum (null when closed / no baseline)
  holiday: string | null;
  payday: boolean;                  // 25th → end of month / 1st: salary window
  weather: ForecastWeather | null;  // filled best-effort by the API layer
  eventNotes: string[];             // team-tagged context for this day (filled by the API layer)
  suggestions: string[];
};
export type BranchForecast = {
  fromDate: string; days: number; hasBaseline: boolean;
  momentumPct: number | null;       // recent 2 weeks vs trailing 8 weeks, %
  lat: number | null; lon: number | null;
  rows: ForecastDay[];
};

/** A branch's realised daily net over an inclusive ISO range — POS for a
 *  restaurant, billed net for a clinic, so the forecast works for both. */
function dailySeries(branchId: number, startIso: string, endIso: string, isClinic: boolean): Array<{ date: string; net: number }> {
  if (isClinic) return clinicaDailyNetRange(branchId, startIso, endIso).filter((d) => d.net > 0);
  return listRange(branchId, startIso, endIso).filter((d) => d.has_sales).map((d) => ({ date: d.sale_date, net: d.nett }));
}

/** Predict the next `days` days for a branch. `closedWeekdays` = branch's regular
 *  closed days (0=Sun..6=Sat); `isClinic` sources the clinic's own history and
 *  tones the suggestions down. */
export function branchForecast(branchId: number, fromIso: string, days: number, closedWeekdays: number[], isClinic = false): BranchForecast {
  // Trailing 8 weeks of realised daily net, up to the day before the plan starts.
  const trail = dailySeries(branchId, addDaysIso(fromIso, -56), addDaysIso(fromIso, -1), isClinic);

  // Average per weekday over that window.
  const byDow = new Map<number, { sum: number; n: number }>();
  for (const d of trail) {
    const dow = new Date(`${d.date}T00:00:00Z`).getUTCDay();
    const e = byDow.get(dow) ?? { sum: 0, n: 0 };
    e.sum += d.net; e.n += 1; byDow.set(dow, e);
  }
  const avgByDow = new Map([...byDow].map(([dow, e]) => [dow, e.n ? e.sum / e.n : 0]));
  const known = [...avgByDow.values()].filter((v) => v > 0);
  const meanWeekday = known.length ? known.reduce((s, v) => s + v, 0) / known.length : 0;

  // Momentum: the last 2 weeks vs the DISJOINT prior 6 weeks (both per active day).
  const cut = addDaysIso(fromIso, -14);
  const recent = trail.filter((d) => d.date >= cut);
  const prior = trail.filter((d) => d.date < cut);
  const recentAvg = recent.length ? recent.reduce((s, d) => s + d.net, 0) / recent.length : 0;
  const baseAvg = prior.length ? prior.reduce((s, d) => s + d.net, 0) / prior.length : 0;
  const momentum = baseAvg > 0 && recentAvg > 0 ? Math.max(0.7, Math.min(1.4, recentAvg / baseAvg)) : 1;
  const momentumPct = baseAvg > 0 && recentAvg > 0 ? round2((momentum - 1) * 100) : null;
  const hasBaseline = meanWeekday > 0;

  const rows: ForecastDay[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDaysIso(fromIso, i);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const dom = Number(date.slice(8, 10));
    const closed = closedWeekdays.includes(dow);
    const weekdayAvg = avgByDow.get(dow) ?? 0;
    const predictedNett = closed ? 0 : (weekdayAvg > 0 ? round2(weekdayAvg * momentum) : null);
    const holiday = holidayOn(date);
    const payday = dom >= 25 || dom <= 1;

    const suggestions: string[] = [];
    if (closed) {
      suggestions.push("ปิดทำการประจำ");
    } else {
      if (predictedNett != null && meanWeekday > 0) {
        if (predictedNett >= meanWeekday * 1.1) suggestions.push(isClinic ? "คาดคนไข้เยอะ — เตรียมคิว/เวชภัณฑ์ให้พอ" : "คาดขายดี — จัดกำลังคนเต็ม เตรียมของให้พอ");
        else if (predictedNett <= meanWeekday * 0.85) suggestions.push(isClinic ? "คาดเงียบ — จัดตารางเบา" : "คาดเงียบ — ลดกำลังคน / จัดโปรฯ กระตุ้น");
      }
      if (holiday) suggestions.push(`${holiday} — พฤติกรรมลูกค้าอาจเปลี่ยน เช็กสต็อก/กำลังคนล่วงหน้า`);
      if (payday && !isClinic) suggestions.push("ช่วงเงินเดือนออก — มักคึกคัก เตรียมของ/คนเพิ่ม");
    }

    rows.push({ date, dow, dowLabel: TH_WEEKDAYS[dow], closed, weekdayAvg, predictedNett, holiday, payday, weather: null, eventNotes: [], suggestions });
  }

  return { fromDate: fromIso, days, hasBaseline, momentumPct, lat: null, lon: null, rows };
}

/** Fold a best-effort weather forecast (keyed by ISO date) onto the plan, adding
 *  weather-driven suggestions. Pure — the network fetch happens in the API layer. */
export function attachWeather(fc: BranchForecast, weatherByDate: Record<string, ForecastWeather>): void {
  for (const r of fc.rows) {
    const w = weatherByDate[r.date];
    if (!w) continue;
    r.weather = w;
    if (r.closed) continue;
    if (w.rainChance != null && w.rainChance >= 60) r.suggestions.push("ฝนน่าจะตก — เดลิเวอรีอาจเพิ่ม หน้าร้านอาจลด เตรียมร่ม/ที่นั่งในร่ม");
    if (w.tempMax != null && w.tempMax >= 35) r.suggestions.push("อากาศร้อน — เครื่องดื่ม/ของเย็นน่าจะขายดี");
  }
}

/** Fold team-tagged event notes (keyed by ISO date) onto the plan. Pure — the DB
 *  read happens in the API layer so `branchForecast` stays testable without a DB. */
export function attachEventNotes(fc: BranchForecast, notesByDate: Record<string, string[]>): void {
  for (const r of fc.rows) {
    const notes = notesByDate[r.date];
    if (notes && notes.length) r.eventNotes = notes;
  }
}

/** Build a branch's forward plan (clamped 3–7 days, starting tomorrow), with a
 *  best-effort weather fold. One place so the GET preview and the LINE send agree. */
export async function forecastForBranch(branchId: number, days: number): Promise<BranchForecast> {
  const d = Math.min(7, Math.max(3, days || 7));
  const b = getDb().prepare("SELECT closed_weekdays, latitude, longitude FROM branches WHERE id = ?")
    .get(branchId) as { closed_weekdays: string | null; latitude: number | null; longitude: number | null } | undefined;
  let closed: number[] = [];
  try { const a = JSON.parse(b?.closed_weekdays ?? "[]"); if (Array.isArray(a)) closed = a.filter((x) => Number.isInteger(x) && x >= 0 && x <= 6); } catch { closed = []; }
  const fromIso = new Date(Date.now() + 7 * 3600_000 + 86_400_000).toISOString().slice(0, 10);   // tomorrow (Bangkok)
  const fc = branchForecast(branchId, fromIso, d, closed, isClinicaBranch(branchId));
  fc.lat = b?.latitude ?? null;
  fc.lon = b?.longitude ?? null;
  // Team-tagged event notes for the plan window (owner 2026-09-27).
  attachEventNotes(fc, eventNotesByDate(branchId, fromIso, addDaysIso(fromIso, d - 1)));
  // The plan starts tomorrow, so ask Open-Meteo for d+1 forecast days (today
  // through today+d) to cover tomorrow…today+d; attachWeather keys by exact date,
  // so today's entry is simply ignored.
  if (fc.lat != null && fc.lon != null) attachWeather(fc, await fetchBranchWeather(fc.lat, fc.lon, d + 1));
  return fc;
}
