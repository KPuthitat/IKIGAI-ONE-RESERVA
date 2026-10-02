// IR — Incident Report / Risk Management, server data layer.
//
// Staff file an incident/near-miss (แนว รพ. IR); the RM team reviews it in the
// weekly meeting, records a root cause + corrective action (PDCA) and tracks it
// to closure. Non-punitive (HA): the reporter may stay anonymous. Everything is
// branch-scoped through ir_reports.branch_id. Owner 2026-08.

import { getDb } from "./db";
import {
  IR_OPEN_STATUSES, IR_MAX_WHYS, IR_MAX_RECOMMENDATIONS, IR_MAX_PEOPLE, IR_FACTOR_KEYS, categoryGroup,
  type IrSeverity, type IrIncidentType, type IrStatus, type IrPersonRole
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
  // Reporter's structured account + RCA (owner 2026-10-01). JSON columns are
  // parsed by the view helpers below; raw here.
  timeline: string | null;
  impact: string | null;
  why_chain_json: string | null;
  contributing_json: string | null;
  reporter_root_cause: string | null;
  recommendations_json: string | null;
  self_involved: number;
  reporter_updated_at: string | null;
};

// Another person named in the report. user_id is null for a non-employee.
export type IrPerson = {
  id: number;
  report_id: number;
  user_id: number | null;
  name: string;
  role: IrPersonRole;
  note: string | null;
};
export type IrPersonInput = { userId?: number | null; name?: string | null; role: IrPersonRole; note?: string | null };

// The reporter's RCA sections, decoded from the JSON columns.
export type IrRca = {
  whyChain: string[];
  contributing: string[];
  recommendations: string[];
};

// A row joined with the reporter / assignee display names for list + detail.
// Reporter name is deliberately withheld when is_anonymous — never leak it.
export type IrReportView = IrReport & {
  reporter_name: string | null;
  reporter_prefix: string | null;
  assignee_name: string | null;
  assignee_prefix: string | null;
};

// Detail view = the row + decoded RCA + the people named (owner 2026-10-01).
export type IrReportDetail = IrReportView & { rca: IrRca; people: IrPerson[] };

function parseList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
  } catch { return []; }
}
export function decodeRca(r: Pick<IrReport, "why_chain_json" | "contributing_json" | "recommendations_json">): IrRca {
  return {
    whyChain: parseList(r.why_chain_json),
    contributing: parseList(r.contributing_json).filter((k) => (IR_FACTOR_KEYS as string[]).includes(k)),
    recommendations: parseList(r.recommendations_json)
  };
}
const cleanList = (arr: string[] | undefined | null, max: number, maxLen = 600): string[] | undefined =>
  arr === undefined || arr === null ? undefined
    : arr.map((x) => String(x ?? "").trim().slice(0, maxLen)).filter((x) => x.length > 0).slice(0, max);

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

export function listPeople(reportId: number): IrPerson[] {
  return getDb().prepare(
    "SELECT id, report_id, user_id, name, role, note FROM ir_report_people WHERE report_id = ? ORDER BY id"
  ).all(reportId) as IrPerson[];
}

/** One report with its decoded RCA and the people named in it. */
export function getReportDetail(id: number, branchId: number): IrReportDetail | null {
  const r = getReport(id, branchId);
  if (!r) return null;
  return { ...r, rca: decodeRca(r), people: listPeople(r.id) };
}

/** Replace the people named in a report. An employee entry resolves its display
 *  name from users (so a typed name can't impersonate); a non-employee keeps the
 *  typed name. Capped at IR_MAX_PEOPLE; blank entries dropped. */
export function setPeople(reportId: number, people: IrPersonInput[]): IrPerson[] {
  const db = getDb();
  const nameOf = db.prepare("SELECT display_name, title_prefix FROM users WHERE id = ?");
  const rows: Array<{ userId: number | null; name: string; role: IrPersonRole; note: string | null }> = [];
  const seenUser = new Set<number>();
  for (const p of people.slice(0, IR_MAX_PEOPLE)) {
    const role: IrPersonRole = p.role === "witness" || p.role === "affected" ? p.role : "involved";
    const note = p.note?.trim().slice(0, 300) || null;
    if (p.userId != null) {
      if (seenUser.has(p.userId)) continue;
      const u = nameOf.get(p.userId) as { display_name: string; title_prefix: string | null } | undefined;
      if (!u) continue;
      seenUser.add(p.userId);
      rows.push({ userId: p.userId, name: u.display_name, role, note });
    } else {
      const name = p.name?.trim().slice(0, 120);
      if (!name) continue;
      rows.push({ userId: null, name, role, note });
    }
  }
  db.transaction(() => {
    db.prepare("DELETE FROM ir_report_people WHERE report_id = ?").run(reportId);
    const ins = db.prepare("INSERT INTO ir_report_people (report_id, user_id, name, role, note) VALUES (?, ?, ?, ?, ?)");
    for (const r of rows) ins.run(reportId, r.userId, r.name, r.role, r.note);
  })();
  return listPeople(reportId);
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
  // Reporter's structured account (owner 2026-10-01) — all optional so a quick
  // near-miss note still files; the full form asks for them.
  timeline?: string | null;
  impact?: string | null;
  whyChain?: string[];
  contributing?: string[];
  reporterRootCause?: string | null;
  recommendations?: string[];
  selfInvolved?: boolean;
  people?: IrPersonInput[];
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
  const whyChain = cleanList(input.whyChain, IR_MAX_WHYS) ?? [];
  const contributing = [...new Set((cleanList(input.contributing, IR_FACTOR_KEYS.length, 40) ?? []).filter((k) => (IR_FACTOR_KEYS as string[]).includes(k)))];
  const recommendations = cleanList(input.recommendations, IR_MAX_RECOMMENDATIONS) ?? [];
  const info = db.prepare(
    `INSERT INTO ir_reports
       (code, branch_id, reporter_user_id, is_anonymous, occurred_at,
        location_detail, category, incident_type, severity,
        description, immediate_action, status,
        timeline, impact, why_chain_json, contributing_json, reporter_root_cause,
        recommendations_json, self_involved, reporter_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).run(
    code, input.branchId,
    input.isAnonymous ? null : input.reporterUserId,
    input.isAnonymous ? 1 : 0,
    input.occurredAt, input.locationDetail ?? null,
    input.category, input.incidentType, input.severity,
    input.description.trim(), input.immediateAction?.trim() || null,
    input.timeline?.trim() || null, input.impact?.trim() || null,
    whyChain.length ? JSON.stringify(whyChain) : null,
    contributing.length ? JSON.stringify(contributing) : null,
    input.reporterRootCause?.trim() || null,
    recommendations.length ? JSON.stringify(recommendations) : null,
    input.selfInvolved ? 1 : 0
  );
  const id = Number(info.lastInsertRowid);
  if (input.people?.length) setPeople(id, input.people);
  return db.prepare("SELECT * FROM ir_reports WHERE id = ?").get(id) as IrReport;
}

// ── Reporter self-edit (owner 2026-10-01) ─────────────────────────────────
// The person who filed the report may refine THEIR sections (facts, RCA,
// recommendations, people) until the RM closes or dismisses the case. The RM
// verdict columns (status / root_cause / corrective_action / assignment) are
// never touched here. Anonymous reports have no owner and cannot be edited.

export type ReporterEditInput = {
  occurredAt?: string;
  locationDetail?: string | null;
  category?: string;
  incidentType?: IrIncidentType;
  severity?: IrSeverity;
  description?: string;
  immediateAction?: string | null;
  timeline?: string | null;
  impact?: string | null;
  whyChain?: string[];
  contributing?: string[];
  reporterRootCause?: string | null;
  recommendations?: string[];
  selfInvolved?: boolean;
  people?: IrPersonInput[];
};

export type ReporterEditResult =
  | { ok: true; report: IrReportDetail }
  | { ok: false; error: "not_found" | "not_owner" | "closed" };

/** May this user still edit the reporter sections of this report? */
export function canReporterEdit(r: Pick<IrReport, "reporter_user_id" | "is_anonymous" | "status">, userId: number): boolean {
  return r.is_anonymous !== 1 && r.reporter_user_id === userId && (IR_OPEN_STATUSES as string[]).includes(r.status);
}

export function updateReporterSections(
  id: number, branchId: number, userId: number, patch: ReporterEditInput
): ReporterEditResult {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM ir_reports WHERE id = ? AND branch_id = ?").get(id, branchId) as IrReport | undefined;
  if (!existing) return { ok: false, error: "not_found" };
  if (existing.is_anonymous === 1 || existing.reporter_user_id !== userId) return { ok: false, error: "not_owner" };
  if (!(IR_OPEN_STATUSES as string[]).includes(existing.status)) return { ok: false, error: "closed" };

  const fields: string[] = [];
  const vals: Array<string | number | null> = [];
  const set = (col: string, v: string | number | null | undefined) => {
    if (v !== undefined) { fields.push(`${col} = ?`); vals.push(v); }
  };
  const text = (v: string | null | undefined) => (v === undefined ? undefined : (v?.trim() || null));
  const list = (arr: string[] | undefined, max: number) => {
    const c = cleanList(arr, max);
    return c === undefined ? undefined : (c.length ? JSON.stringify(c) : null);
  };
  set("occurred_at", patch.occurredAt);
  // The code is IR-<occurred year>-####; moving the incident to another year
  // re-issues it in that year so two reports never share a code.
  if (patch.occurredAt && patch.occurredAt.slice(0, 4) !== existing.occurred_at.slice(0, 4)) {
    set("code", nextCode(branchId, patch.occurredAt));
  }
  set("location_detail", text(patch.locationDetail));
  set("category", patch.category);
  set("incident_type", patch.incidentType);
  set("severity", patch.severity);
  if (patch.description !== undefined && patch.description.trim()) set("description", patch.description.trim());
  set("immediate_action", text(patch.immediateAction));
  set("timeline", text(patch.timeline));
  set("impact", text(patch.impact));
  set("why_chain_json", list(patch.whyChain, IR_MAX_WHYS));
  const contributing = patch.contributing === undefined ? undefined
    : patch.contributing.filter((k) => (IR_FACTOR_KEYS as string[]).includes(k));
  set("contributing_json", contributing === undefined ? undefined : (contributing.length ? JSON.stringify([...new Set(contributing)]) : null));
  set("reporter_root_cause", text(patch.reporterRootCause));
  set("recommendations_json", list(patch.recommendations, IR_MAX_RECOMMENDATIONS));
  set("self_involved", patch.selfInvolved === undefined ? undefined : (patch.selfInvolved ? 1 : 0));

  db.transaction(() => {
    if (fields.length) {
      fields.push("reporter_updated_at = CURRENT_TIMESTAMP", "updated_at = CURRENT_TIMESTAMP");
      vals.push(id, branchId);
      db.prepare(`UPDATE ir_reports SET ${fields.join(", ")} WHERE id = ? AND branch_id = ?`).run(...vals);
    }
    if (patch.people !== undefined) setPeople(id, patch.people);
  })();
  return { ok: true, report: getReportDetail(id, branchId)! };
}

/** Active employees who can be named in a report / own a corrective action —
 *  one list for the staff form, the admin form and the RM assignee picker. */
export type IrColleague = { id: number; display_name: string; title_prefix: string | null };
export function irColleagues(): IrColleague[] {
  return getDb().prepare(
    `SELECT id, display_name, title_prefix FROM users
     WHERE role IN ('staff','admin') AND status NOT IN ('disabled','resigned')
     ORDER BY display_name`
  ).all() as IrColleague[];
}

/** Reports a user filed or is named in (for "ของฉัน" filters). */
export function reportIdsTouching(branchId: number, userId: number): Set<number> {
  const rows = getDb().prepare(
    `SELECT r.id FROM ir_reports r WHERE r.branch_id = ? AND r.reporter_user_id = ?
     UNION
     SELECT p.report_id FROM ir_report_people p JOIN ir_reports r ON r.id = p.report_id
     WHERE r.branch_id = ? AND p.user_id = ?`
  ).all(branchId, userId, branchId, userId) as Array<{ id: number }>;
  return new Set(rows.map((x) => x.id));
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
