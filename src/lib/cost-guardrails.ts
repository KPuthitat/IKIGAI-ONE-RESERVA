// Restaurant cost-structure guardrails (owner 2026-11-25): each expense category as a % of revenue against a band
// (COGS 30–35, labor 15–20, occupancy 15–20, utilities 1–5, marketing 2–5, G&A 1–5; profit before tax 15–20).
// The bands live on accounta_categories.target_pct_min/max (the same ones the expenses page already colours) plus the
// profit band in corporate_goal_state, so there is one place to edit them. Revenue here is the books' income net of the
// revenue-share payout (partner sales sit inside gross sales and are forwarded to the partner, so they are not ours),
// and CapEx is left out of costs (a one-off investment is not an operating cost).

import { getDb } from "./db";
import { categoryBudget } from "./accounta-db";

const getState = (key: string): string | null => (getDb().prepare("SELECT value FROM corporate_goal_state WHERE key = ?").get(key) as { value: string | null } | undefined)?.value ?? null;
const setState = (key: string, value: string): void => { getDb().prepare("INSERT INTO corporate_goal_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").run(key, value); };
const round2 = (n: number) => Math.round(n * 100) / 100;
export const PROFIT_DEFAULT = { min: 15, max: 20 };
const SKIP_CODES = new Set(["CP", "PR"]);   // CapEx, revenue-share payout

export type CostRow = { code: string | null; name: string; spent: number; pct: number | null; min: number | null; max: number | null; status: "over" | "under" | "ok" | "na" };
export type CostRatios = {
  month: string; branchId: number | null; revenueBooks: number; partnerPayout: number; revenue: number;
  rows: CostRow[]; costTotal: number; profit: number; profitPct: number | null; profitBand: { min: number; max: number }; profitStatus: "under" | "ok" | "over" | "na";
};

export function profitBand(): { min: number; max: number } {
  const mn = Number(getState("profit_min")), mx = Number(getState("profit_max"));
  return { min: Number.isFinite(mn) && getState("profit_min") != null ? mn : PROFIT_DEFAULT.min, max: Number.isFinite(mx) && getState("profit_max") != null ? mx : PROFIT_DEFAULT.max };
}

export function buildCostRatios(month: string, branchId: number | null): CostRatios {
  const b = categoryBudget(month, branchId);
  const payout = b.items.find((i) => i.code === "PR")?.spent ?? 0;
  const revenue = round2(b.revenue - payout);
  const rows: CostRow[] = b.items.filter((i) => !SKIP_CODES.has(i.code ?? "") && i.spent > 0).map((i) => {
    const pct = revenue > 0 ? round2((i.spent / revenue) * 100) : null;
    let status: CostRow["status"] = "ok";
    if (pct == null || (i.targetMin == null && i.targetMax == null)) status = "na";
    else if (i.targetMax != null && pct > i.targetMax) status = "over";
    else if (i.targetMin != null && pct < i.targetMin) status = "under";
    return { code: i.code, name: i.name, spent: i.spent, pct, min: i.targetMin, max: i.targetMax, status };
  });
  const costTotal = round2(rows.reduce((s, r) => s + r.spent, 0) + b.uncategorized);
  const profit = round2(revenue - costTotal);
  const profitPct = revenue > 0 ? round2((profit / revenue) * 100) : null;
  const band = profitBand();
  const profitStatus: CostRatios["profitStatus"] = profitPct == null ? "na" : profitPct < band.min ? "under" : profitPct > band.max ? "over" : "ok";
  return { month, branchId, revenueBooks: b.revenue, partnerPayout: payout, revenue, rows, costTotal, profit, profitPct, profitBand: band, profitStatus };
}

/** Lines worth a LINE alert: a cost over its band, or profit under its band. */
export function costAlerts(r: CostRatios): string[] {
  const out = r.rows.filter((x) => x.status === "over" && x.pct != null).map((x) => `${x.name} ${x.pct}% (เกณฑ์ ${x.min ?? 0}–${x.max}%)`);
  if (r.profitStatus === "under" && r.profitPct != null) out.push(`กำไรก่อนภาษี ${r.profitPct}% (เกณฑ์ ${r.profitBand.min}–${r.profitBand.max}%)`);
  return out;
}

/** Edit one band. `code` is a category code, or "PROFIT" for the profit band. */
export function setBand(code: string, min: number | null, max: number | null): boolean {
  if ((min != null && max != null && min > max) || (min != null && min < 0) || (max != null && max > 100)) return false;
  if (code === "PROFIT") { if (min == null || max == null) return false; setState("profit_min", String(min)); setState("profit_max", String(max)); return true; }
  return getDb().prepare("UPDATE accounta_categories SET target_pct_min = ?, target_pct_max = ? WHERE code = ?").run(min, max, code).changes > 0;
}
