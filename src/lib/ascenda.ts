// ASCENDA — KPI/OKR evaluation helpers (2026-05-27).
//
// Owner direction: a flexible pattern that lets admin add/remove KPI
// criteria. Each KPI declares a `kind` that picks a calculator (or
// stays manual). Results are stored monthly; quarter + year views
// aggregate at display time. Scoring is weighted — each branch's
// monthly score = Σ (weight × passing) ÷ Σ weight × 100%.
//
// This file holds the type contracts + pure helpers (period math,
// aggregation, status from value). The auto-calculators that need
// DB joins (attendance %, COL %, sales growth) live in
// ascenda-engine.ts so the read-only display path doesn't pull in
// the whole roster/time-entry world.

import { getDb } from "./db";

export type KpiScope = "branch" | "company";

export type KpiKind =
  | "attendance_pct"      // auto: time_entries + leave_requests
  | "incident_count"      // manual count
  | "wrong_order_count"   // manual count
  | "complaint_count"     // manual count
  | "cog_pct"             // manual percentage
  | "col_pct_auto"        // auto: roster × rate ÷ rev_avg_3m
  | "sales_growth_pct"    // auto: monthly revenue MoM
  | "manual_number"       // generic numeric input
  | "manual_pct";         // generic percentage input

export type TargetOp = "lte" | "gte" | "eq";

export type AscendaKpi = {
  id: number;
  scope: KpiScope;
  kind: KpiKind;
  title: string;
  description: string | null;
  unit: string | null;
  target_value: number | null;
  target_op: TargetOp | null;
  weight: number;
  display_order: number;
  active: number;
};

export type ResultStatus = "pass" | "fail" | "na" | "pending";

export type AscendaResult = {
  id: number;
  kpi_id: number;
  branch_id: number | null;
  period_key: string;       // "YYYY-MM"
  actual_value: number | null;
  status: ResultStatus | null;
  notes: string | null;
  computed_by_system: number;
  recorded_by: number | null;
  recorded_at: string | null;
};

/** Whether the KPI's calculator is auto (engine fills) or manual
 *  (admin enters). Determines if the result row gets locked in the
 *  edit UI + whether the engine sweep regenerates it. */
export function isAutoKind(kind: KpiKind): boolean {
  return kind === "attendance_pct"
    || kind === "col_pct_auto"
    || kind === "sales_growth_pct";
}

/** Evaluate pass/fail given an actual value + KPI rule. Returns "na"
 *  when actual is null/undefined or the rule isn't fully configured —
 *  caller can show "—" for that. */
export function evaluateStatus(
  actual: number | null | undefined,
  targetValue: number | null,
  targetOp: TargetOp | null
): ResultStatus {
  if (actual == null) return "pending";
  if (targetValue == null || !targetOp) return "na";
  if (targetOp === "lte") return actual <= targetValue ? "pass" : "fail";
  if (targetOp === "gte") return actual >= targetValue ? "pass" : "fail";
  return Math.abs(actual - targetValue) < 1e-9 ? "pass" : "fail";
}

/** Bangkok-local YYYY-MM for a given JS Date (defaults to now). The
 *  ASCENDA module is monthly-driven; this is the canonical period key. */
export function currentPeriodKey(d: Date = new Date()): string {
  return new Date(d.getTime() + 7 * 60 * 60 * 1000)
    .toISOString().slice(0, 7);
}

/** Return the N most-recent period keys ending at `endPeriodKey`
 *  (inclusive). Useful for the trailing-3-months window the COL %
 *  calculator needs. */
export function recentPeriodKeys(endPeriodKey: string, count: number): string[] {
  const [y, m] = endPeriodKey.split("-").map(Number);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    // Walk back i months from (y, m). JS Date handles month underflow.
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

// ── Read helpers ────────────────────────────────────────────────

export function listKpis(scope?: KpiScope, onlyActive = true): AscendaKpi[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (scope) {
    where.push("scope = ?");
    params.push(scope);
  }
  if (onlyActive) where.push("active = 1");
  const sql = `
    SELECT id, scope, kind, title, description, unit, target_value,
           target_op, weight, display_order, active
    FROM ascenda_kpis
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY display_order ASC, id ASC
  `;
  return getDb().prepare(sql).all(...params) as AscendaKpi[];
}

export function getKpi(id: number): AscendaKpi | null {
  const row = getDb().prepare(`
    SELECT id, scope, kind, title, description, unit, target_value,
           target_op, weight, display_order, active
    FROM ascenda_kpis WHERE id = ?
  `).get(id) as AscendaKpi | undefined;
  return row ?? null;
}

/** Fetch every result for a given period. branch_id may be NULL on
 *  company-scope KPI rows; callers filter by scope when needed. */
export function listResultsForPeriod(periodKey: string): AscendaResult[] {
  return getDb().prepare(`
    SELECT id, kpi_id, branch_id, period_key, actual_value, status,
           notes, computed_by_system, recorded_by, recorded_at
    FROM ascenda_results
    WHERE period_key = ?
  `).all(periodKey) as AscendaResult[];
}

/** Composite "scorecard" row for one branch in one month: weighted
 *  pass percentage + counts. Pure function — caller supplies the
 *  KPI definitions + the result rows it cares about. */
export type ScoreCard = {
  totalWeight: number;
  passingWeight: number;
  percentScore: number;     // 0-100
  passCount: number;
  failCount: number;
  pendingCount: number;
};

export function computeScoreCard(
  kpis: AscendaKpi[],
  results: AscendaResult[]
): ScoreCard {
  const byKpi = new Map<number, AscendaResult>();
  for (const r of results) byKpi.set(r.kpi_id, r);
  let totalWeight = 0;
  let passingWeight = 0;
  let passCount = 0;
  let failCount = 0;
  let pendingCount = 0;
  for (const k of kpis) {
    const r = byKpi.get(k.id);
    const status = r?.status ?? "pending";
    if (status === "na") continue; // exclude NA from the denominator
    totalWeight += k.weight;
    if (status === "pass") {
      passingWeight += k.weight;
      passCount += 1;
    } else if (status === "fail") {
      failCount += 1;
    } else {
      pendingCount += 1;
    }
  }
  return {
    totalWeight,
    passingWeight,
    percentScore: totalWeight > 0
      ? Math.round((passingWeight / totalWeight) * 1000) / 10
      : 0,
    passCount,
    failCount,
    pendingCount
  };
}

/** Friendly Thai label for the status pill. */
export function statusLabelTh(s: ResultStatus): string {
  if (s === "pass") return "ผ่าน";
  if (s === "fail") return "ไม่ผ่าน";
  if (s === "pending") return "รอข้อมูล";
  return "—";
}

// ── Daily revenue helpers ────────────────────────────────────────

/** Upsert one day of branch revenue. Used by the shift_close hook
 *  (source='shift_close') and the admin override page
 *  (source='admin_edit'). The UNIQUE (branch_id, date) constraint
 *  means INSERT OR REPLACE updates in-place on re-submission. */
export function upsertBranchDailyRevenue(args: {
  branchId: number;
  date: string;            // YYYY-MM-DD
  revenue: number;
  userId: number;
  source: "shift_close" | "admin_edit";
}): { id: number; created: boolean } {
  const db = getDb();
  const existing = db.prepare(
    "SELECT id FROM branch_daily_revenue WHERE branch_id = ? AND date = ?"
  ).get(args.branchId, args.date) as { id: number } | undefined;
  const now = new Date().toISOString();
  if (existing) {
    db.prepare(`
      UPDATE branch_daily_revenue
      SET revenue = ?, recorded_by = ?, recorded_at = ?, source = ?
      WHERE id = ?
    `).run(args.revenue, args.userId, now, args.source, existing.id);
    return { id: existing.id, created: false };
  }
  const r = db.prepare(`
    INSERT INTO branch_daily_revenue
      (branch_id, date, revenue, recorded_by, recorded_at, source)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(args.branchId, args.date, args.revenue, args.userId, now, args.source);
  return { id: Number(r.lastInsertRowid), created: true };
}

export type DailyRevenueRow = {
  id: number;
  branch_id: number;
  date: string;
  revenue: number;
  recorded_by: number | null;
  recorded_at: string;
  source: string | null;
};

/** Recent revenue rows for a branch, newest first. Used by the admin
 *  override page; caller passes a row limit to bound the result. */
export function listRecentBranchRevenue(
  branchId: number,
  limit: number
): DailyRevenueRow[] {
  return getDb().prepare(`
    SELECT id, branch_id, date, revenue, recorded_by, recorded_at, source
    FROM branch_daily_revenue
    WHERE branch_id = ?
    ORDER BY date DESC
    LIMIT ?
  `).all(branchId, limit) as DailyRevenueRow[];
}

/** Monthly revenue total for a branch over the given period key. Used
 *  by the COL % calculator + sales-growth comparison. Returns 0 when
 *  no rows exist for the month (caller can treat as "no data"). */
export function monthlyBranchRevenue(branchId: number, periodKey: string): number {
  const row = getDb().prepare(`
    SELECT COALESCE(SUM(revenue), 0) AS total
    FROM branch_daily_revenue
    WHERE branch_id = ?
      AND substr(date, 1, 7) = ?
  `).get(branchId, periodKey) as { total: number } | undefined;
  return row?.total ?? 0;
}

/** Friendly Thai label for the kind — drives the "ที่มา" column in
 *  the KPI list UI. */
export function kindLabelTh(k: KpiKind): string {
  switch (k) {
    case "attendance_pct":     return "อัตโนมัติ · เวลาทำงาน";
    case "col_pct_auto":       return "อัตโนมัติ · COL";
    case "sales_growth_pct":   return "อัตโนมัติ · ยอดขาย";
    case "incident_count":     return "กรอกเอง · นับครั้ง";
    case "wrong_order_count":  return "กรอกเอง · นับครั้ง";
    case "complaint_count":    return "กรอกเอง · นับครั้ง";
    case "cog_pct":            return "กรอกเอง · เปอร์เซ็นต์";
    case "manual_number":      return "กรอกเอง · ตัวเลข";
    case "manual_pct":         return "กรอกเอง · เปอร์เซ็นต์";
  }
}
