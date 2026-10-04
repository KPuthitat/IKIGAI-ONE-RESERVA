// Material-purchase quota — the forecast-driven entry point (owner 2026-10-04).
// Gathers the month's target (ANALYTICA first) and the daily sales forecast for
// the remaining days (the same weekday-average engine as the forecast plan), then
// hands them to accounta-db's materialPurchaseQuota. Lives outside accounta-db so
// that module does not import the forecast engine (import-cycle safety).

import { getDb } from "./db";
import { effectiveMonthlyTarget } from "./sales-target";
import { branchForecast } from "./forecast";
import { isClinicaBranch } from "./clinica-db";
import { materialPurchaseQuota, type MaterialQuota, type MaterialPlan } from "./accounta-db";

function addIso(iso: string, n: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

function closedWeekdays(branchId: number): number[] {
  const r = getDb().prepare("SELECT closed_weekdays FROM branches WHERE id = ?").get(branchId) as { closed_weekdays: string | null } | undefined;
  try { const a = JSON.parse(r?.closed_weekdays ?? "[]"); return Array.isArray(a) ? a.filter((x) => Number.isInteger(x) && x >= 0 && x <= 6) : []; } catch { return []; }
}

/** The forecast plan the quota is built on: the target + predicted sales of every
 *  remaining day of `date`'s month (tomorrow → month end; today as well while no
 *  sales are in yet, so day 1 has a full-month base). */
export function materialPlan(branchId: number, date: string, salesToDate: number): MaterialPlan {
  const { target, source } = effectiveMonthlyTarget(branchId, date.slice(0, 7));
  const [yy, mm] = date.split("-").map(Number);
  const monthEnd = `${date.slice(0, 7)}-${String(new Date(Date.UTC(yy, mm, 0)).getUTCDate()).padStart(2, "0")}`;
  const from = salesToDate > 0 ? addIso(date, 1) : date;
  const n = Math.max(0, Math.round((new Date(`${monthEnd}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000) + 1);
  if (n <= 0) return { target, targetSource: source, hasForecast: false, days: [] };
  const fc = branchForecast(branchId, from, n, closedWeekdays(branchId), isClinicaBranch(branchId));
  // The purchase-day window can reach past month end, so also forecast a week beyond
  // is NOT needed: the window is clipped to the month on purpose (the next month's
  // budget is its own).
  return {
    target, targetSource: source, hasForecast: fc.hasBaseline,
    days: fc.rows.map((r) => ({ date: r.date, dow: r.dow, predicted: r.predictedNett ?? 0, closed: r.closed }))
  };
}

/** Today's material-purchase quota for a branch (null when the feature is off).
 *  `salesToDate` = the month's sales so far (the ledger's figure on the page). */
export function materialQuotaFor(branchId: number, date: string, salesToDate: number | null | undefined, runRateForecast?: number | null): MaterialQuota | null {
  const sold = Number(salesToDate) || 0;
  return materialPurchaseQuota(branchId, date, runRateForecast ?? null, sold, materialPlan(branchId, date, sold));
}
