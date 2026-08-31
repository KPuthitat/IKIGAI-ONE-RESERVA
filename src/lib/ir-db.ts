// IR — Incident Report / Risk Management, server data layer.
//
// Staff file an incident/near-miss (แนว รพ. IR); the RM team reviews it in the
// weekly meeting, records a root cause + corrective action (PDCA) and tracks it
// to closure. Non-punitive (HA): the reporter may stay anonymous. Everything is
// branch-scoped through ir_reports.branch_id. Owner 2026-08.

import { getDb } from "./db";
import {
  IR_OPEN_STATUSES, categoryGroup,
  type IrSeverity, type IrIncidentType, type IrStatus
} from "./ir-vocab";

// Re-export the client-safe vocabulary so server callers can keep importing
// everything from "@/lib/ir-db". The catalogs themselves live in ir-vocab.ts
// (no better-sqlite3) so client components can import them too.
export * from "./ir-vocab";

// ── Row types ─────────────────────────────────────────────────────

export type IrReport = {
  id: number;
  code: string | null;
  branch_id: number;
  reporter_user_id: number | null;
  is_anonymous: number;
  occurred_at: string;
  location_detail: string | null;
  category: string;
  incident_type: IrIncidentType;
  severity: number;
  description: string;
  immediate_action: string | null;
  status: IrStatus;
  root_cause: string | null;
  corrective_action: string | null;
  assigned_to: number | null;
  due_date: string | null;
  discussed_at: string | null;
  reviewed_by: number | null;
  reviewed_at: string | null;
  resolved_by: number | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

// A row joined with the reporter / assignee display names for list + detail.
// Reporter name is deliberately withheld when is_anonymous — never leak it.
export type IrReportView = IrReport & {
  reporter_name: string | null;
  reporter_prefix: string | null;
  assignee_name: string | null;
  assignee_prefix: string | null;
};

const VIEW_SELECT = `
  SELECT r.*,
         CASE WHEN r.is_anonymous = 1 THEN NULL ELSE ru.display_name END AS reporter_name,
         CASE WHEN r.is_anonymous = 1 THEN NULL ELSE ru.title_prefix END AS reporter_prefix,
         au.display_name AS assignee_name,
         au.title_prefix AS assignee_prefix
  FROM ir_reports r
  LEFT JOIN users ru ON ru.id = r.reporter_user_id
  LEFT JOIN users au ON au.id = r.assigned_to
`;

// ── Reads ─────────────────────────────────────────────────────────

export type IrListFilter = {
  branchId: number;
  status?: IrStatus | "open" | "all";
  severity?: IrSeverity;
  category?: string;
  limit?: number;
};

export function listReports(f: IrListFilter): IrReportView[] {
  const db = getDb();
  const where: string[] = ["r.branch_id = ?"];
  const args: Array<string | number> = [f.branchId];
  if (f.status && f.status !== "all") {
    if (f.status === "open") {
      where.push(`r.status IN (${IR_OPEN_STATUSES.map(() => "?").join(",")})`);
      args.push(...IR_OPEN_STATUSES);
    } else {
      where.push("r.status = ?");
      args.push(f.status);
    }
  }
  if (f.severity) { where.push("r.severity = ?"); args.push(f.severity); }
  if (f.category) { where.push("r.category = ?"); args.push(f.category); }
  const limit = Math.min(Math.max(f.limit ?? 200, 1), 500);
  return db.prepare(
    `${VIEW_SELECT} WHERE ${where.join(" AND ")}
     ORDER BY (r.status IN ('new','reviewing','action')) DESC,
              r.occurred_at DESC, r.id DESC
     LIMIT ${limit}`
  ).all(...args) as IrReportView[];
}

export function getReport(id: number, branchId: number): IrReportView | null {
  const db = getDb();
  return (db.prepare(`${VIEW_SELECT} WHERE r.id = ? AND r.branch_id = ?`)
    .get(id, branchId) as IrReportView | undefined) ?? null;
}

export function openCount(branchId: number): number {
  const db = getDb();
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM ir_reports
     WHERE branch_id = ? AND status IN (${IR_OPEN_STATUSES.map(() => "?").join(",")})`
  ).get(branchId, ...IR_OPEN_STATUSES) as { n: number };
  return row.n;
}

// ── Writes ────────────────────────────────────────────────────────

export type CreateReportInput = {
  branchId: number;
  reporterUserId: number | null;   // the logged-in filer, or null
  isAnonymous: boolean;
  occurredAt: string;
  locationDetail?: string | null;
  category: string;
  incidentType: IrIncidentType;
  severity: IrSeverity;
  description: string;
  immediateAction?: string | null;
};

// IR-YYYY-#### per branch-year, gap-free by counting existing rows in that year.
function nextCode(branchId: number, occurredAt: string): string {
  const db = getDb();
  const year = new Date(occurredAt).getFullYear();
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM ir_reports
     WHERE branch_id = ? AND substr(occurred_at, 1, 4) = ?`
  ).get(branchId, String(year)) as { n: number };
  return `IR-${year}-${String(row.n + 1).padStart(4, "0")}`;
}

export function createReport(input: CreateReportInput): IrReport {
  const db = getDb();
  const code = nextCode(input.branchId, input.occurredAt);
  const info = db.prepare(
    `INSERT INTO ir_reports
       (code, branch_id, reporter_user_id, is_anonymous, occurred_at,
        location_detail, category, incident_type, severity,
        description, immediate_action, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`
  ).run(
    code, input.branchId,
    input.isAnonymous ? null : input.reporterUserId,
    input.isAnonymous ? 1 : 0,
    input.occurredAt, input.locationDetail ?? null,
    input.category, input.incidentType, input.severity,
    input.description.trim(), input.immediateAction?.trim() || null
  );
  return db.prepare("SELECT * FROM ir_reports WHERE id = ?")
    .get(info.lastInsertRowid) as IrReport;
}

export type UpdateReportInput = {
  status?: IrStatus;
  severity?: IrSeverity;
  category?: string;
  rootCause?: string | null;
  correctiveAction?: string | null;
  assignedTo?: number | null;
  dueDate?: string | null;
  discussedAt?: string | null;
};

// Partial update. Stamps reviewed_* the first time it leaves 'new', and
// resolved_* when it reaches a terminal status (cleared if reopened). Returns
// the refreshed view, or null when the row isn't in this branch.
export function updateReport(
  id: number, branchId: number, patch: UpdateReportInput, actorId: number
): IrReportView | null {
  const db = getDb();
  const existing = db.prepare(
    "SELECT * FROM ir_reports WHERE id = ? AND branch_id = ?"
  ).get(id, branchId) as IrReport | undefined;
  if (!existing) return null;

  const fields: string[] = [];
  const vals: Array<string | number | null> = [];
  const set = (col: string, v: string | number | null | undefined) => {
    if (v !== undefined) { fields.push(`${col} = ?`); vals.push(v); }
  };
  set("status", patch.status);
  set("severity", patch.severity);
  set("category", patch.category);
  set("root_cause", patch.rootCause === undefined ? undefined : (patch.rootCause?.trim() || null));
  set("corrective_action", patch.correctiveAction === undefined ? undefined : (patch.correctiveAction?.trim() || null));
  set("assigned_to", patch.assignedTo);
  set("due_date", patch.dueDate);
  set("discussed_at", patch.discussedAt);

  // First move out of 'new' → stamp who reviewed it.
  if (patch.status && patch.status !== "new" && existing.status === "new" && existing.reviewed_at == null) {
    fields.push("reviewed_by = ?", "reviewed_at = CURRENT_TIMESTAMP");
    vals.push(actorId);
  }
  // Reaching a terminal status → stamp resolver; reopening clears it.
  if (patch.status) {
    const terminal = patch.status === "closed" || patch.status === "dismissed";
    if (terminal && existing.resolved_at == null) {
      fields.push("resolved_by = ?", "resolved_at = CURRENT_TIMESTAMP");
      vals.push(actorId);
    } else if (!terminal && existing.resolved_at != null) {
      fields.push("resolved_by = NULL", "resolved_at = NULL");
    }
  }

  if (fields.length === 0) {
    return getReport(id, branchId);
  }
  fields.push("updated_at = CURRENT_TIMESTAMP");
  vals.push(id, branchId);
  db.prepare(`UPDATE ir_reports SET ${fields.join(", ")} WHERE id = ? AND branch_id = ?`).run(...vals);
  return getReport(id, branchId);
}

// ── Dashboard / trend ─────────────────────────────────────────────

export type IrTrend = {
  total: number;
  open: number;
  closed: number;
  overdue: number;                                 // open + past due_date
  byStatus: Record<string, number>;
  bySeverity: Record<number, number>;
  byCategoryGroup: Array<{ group: string; count: number }>;
  byMonth: Array<{ month: string; total: number; high: number }>;  // last 6 months
  recentHigh: IrReportView[];                       // open severity ≥4
};

export function trendFor(branchId: number): IrTrend {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM ir_reports WHERE branch_id = ?"
  ).all(branchId) as IrReport[];

  const today = new Date().toISOString().slice(0, 10);
  const byStatus: Record<string, number> = {};
  const bySeverity: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const groupCount = new Map<string, number>();
  const monthMap = new Map<string, { total: number; high: number }>();

  // Seed the last 6 calendar months so the chart has a continuous axis.
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthMap.set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, { total: 0, high: 0 });
  }

  let open = 0, closed = 0, overdue = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1;
    const g = categoryGroup(r.category);
    groupCount.set(g, (groupCount.get(g) ?? 0) + 1);
    const isOpen = (IR_OPEN_STATUSES as string[]).includes(r.status);
    if (isOpen) open++; else if (r.status === "closed") closed++;
    if (isOpen && r.due_date && r.due_date < today) overdue++;
    const mk = r.occurred_at.slice(0, 7);
    const mm = monthMap.get(mk);
    if (mm) { mm.total++; if (r.severity >= 4) mm.high++; }
  }

  const byCategoryGroup = [...groupCount.entries()]
    .map(([group, count]) => ({ group, count }))
    .sort((a, b) => b.count - a.count);
  const byMonth = [...monthMap.entries()].map(([month, v]) => ({ month, total: v.total, high: v.high }));

  const recentHigh = db.prepare(
    `${VIEW_SELECT} WHERE r.branch_id = ? AND r.severity >= 4
       AND r.status IN (${IR_OPEN_STATUSES.map(() => "?").join(",")})
     ORDER BY r.severity DESC, r.occurred_at DESC LIMIT 5`
  ).all(branchId, ...IR_OPEN_STATUSES) as IrReportView[];

  return {
    total: rows.length, open, closed, overdue,
    byStatus, bySeverity, byCategoryGroup, byMonth, recentHigh
  };
}
