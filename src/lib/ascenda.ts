// ASCENDA — KPI/OKR evaluation DB helpers.
//
// Pure types + browser-safe helpers live in ascenda-types.ts so
// client components can import them without dragging better-sqlite3
// into the browser bundle. This file re-exports those for back-
// compat and adds the helpers that need getDb().

import { getDb } from "./db";
import type { AscendaKpi, AscendaResult, KpiScope, DailyRevenueRow } from "./ascenda-types";

// Re-export every browser-safe symbol so existing
// `import ... from "@/lib/ascenda"` server-side call sites keep
// working without churn.
export type {
  KpiScope,
  KpiKind,
  TargetOp,
  AscendaKpi,
  ResultStatus,
  AscendaResult,
  ScoreCard,
  DailyRevenueRow
} from "./ascenda-types";
export {
  isAutoKind,
  evaluateStatus,
  currentPeriodKey,
  recentPeriodKeys,
  computeScoreCard,
  statusLabelTh,
  kindLabelTh
} from "./ascenda-types";

// ── DB-touching helpers (server-only) ───────────────────────────

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

export function listResultsForPeriod(periodKey: string): AscendaResult[] {
  return getDb().prepare(`
    SELECT id, kpi_id, branch_id, period_key, actual_value, status,
           notes, computed_by_system, recorded_by, recorded_at
    FROM ascenda_results
    WHERE period_key = ?
  `).all(periodKey) as AscendaResult[];
}

// ── Daily revenue helpers ────────────────────────────────────────

export function upsertBranchDailyRevenue(args: {
  branchId: number;
  date: string;
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

export function monthlyBranchRevenue(branchId: number, periodKey: string): number {
  const row = getDb().prepare(`
    SELECT COALESCE(SUM(revenue), 0) AS total
    FROM branch_daily_revenue
    WHERE branch_id = ?
      AND substr(date, 1, 7) = ?
  `).get(branchId, periodKey) as { total: number } | undefined;
  return row?.total ?? 0;
}
