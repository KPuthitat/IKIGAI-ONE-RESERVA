// Pure types + browser-safe helpers for ASCENDA. Split out from
// src/lib/ascenda.ts (2026-05-27) so client components can import
// the helpers without dragging better-sqlite3 (getDb) into the
// browser bundle. Server-side code still imports from ascenda.ts
// (which re-exports these + adds DB-touching functions).

export type KpiScope = "branch" | "company";

export type KpiKind =
  | "attendance_pct"
  | "incident_count"
  | "wrong_order_count"
  | "complaint_count"
  | "cog_pct"
  | "col_pct_auto"
  | "sales_growth_pct"
  | "manual_number"
  | "manual_pct";

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
  // 2026-05-27 — company-scope rows now carry the company_id so each
  // company gets its own evaluation. Branch-scope rows leave it NULL
  // (the branch is the unit) and company-scope rows leave branch_id
  // NULL instead.
  company_id: number | null;
  period_key: string;
  actual_value: number | null;
  status: ResultStatus | null;
  notes: string | null;
  computed_by_system: number;
  recorded_by: number | null;
  recorded_at: string | null;
};

export type ScoreCard = {
  totalWeight: number;
  passingWeight: number;
  percentScore: number;
  passCount: number;
  failCount: number;
  pendingCount: number;
};

export function isAutoKind(kind: KpiKind): boolean {
  return kind === "attendance_pct"
    || kind === "col_pct_auto"
    || kind === "sales_growth_pct";
}

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

export function currentPeriodKey(d: Date = new Date()): string {
  return new Date(d.getTime() + 7 * 60 * 60 * 1000)
    .toISOString().slice(0, 7);
}

export function recentPeriodKeys(endPeriodKey: string, count: number): string[] {
  const [y, m] = endPeriodKey.split("-").map(Number);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

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
    if (status === "na") continue;
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

export function statusLabelTh(s: ResultStatus): string {
  if (s === "pass") return "ผ่าน";
  if (s === "fail") return "ไม่ผ่าน";
  if (s === "pending") return "รอข้อมูล";
  return "—";
}

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

export type DailyRevenueRow = {
  id: number;
  branch_id: number;
  date: string;
  revenue: number;
  recorded_by: number | null;
  recorded_at: string;
  source: string | null;
};
