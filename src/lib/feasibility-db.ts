// FEASIBILITY — data access (SQLite). Every function is scoped to the
// owning user (created_by) — the equivalent of the spec's Supabase RLS,
// enforced here since this project uses better-sqlite3 + session auth.
// Only admin/super_admin reach these (route guards), and a user only ever
// sees their own projects.

import { getDb } from "./db";
import {
  coerceInputs, evaluate, FEASIBILITY_COMPANIES,
  type FeasibilityCompany, type FeasibilityStatus, type FeasibilityInputs
} from "./feasibility";

// Re-export so existing server-side importers keep working; the canonical
// definitions live in feasibility.ts (client-safe — no db import).
export { FEASIBILITY_COMPANIES };
export type { FeasibilityCompany, FeasibilityStatus };

export type FeasibilitySummary = {
  verdict: "go" | "caution" | "no";
  profit: number;        // base-case profit / month
  paybackMonths: number; // base-case payback
};

export type FeasibilityRow = {
  id: number;
  created_by: number;
  company: string;
  project_name: string;
  location: string | null;
  business_type: string | null;
  status: string;
  inputs: string;        // JSON
  summary_cache: string | null;
  created_at: string;
  updated_at: string;
};

export type FeasibilityProject = Omit<FeasibilityRow, "inputs" | "summary_cache"> & {
  inputs: FeasibilityInputs;
  summary: FeasibilitySummary | null;
};

function parseInputs(raw: string): FeasibilityInputs {
  try {
    return coerceInputs(JSON.parse(raw));
  } catch {
    return coerceInputs(null);
  }
}

function summaryOf(inputs: FeasibilityInputs): FeasibilitySummary {
  const r = evaluate(inputs);
  return { verdict: r.decision.verdict, profit: r.base.profit, paybackMonths: r.base.paybackMonths };
}

function parseSummary(raw: string | null): FeasibilitySummary | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as FeasibilitySummary; } catch { return null; }
}

/** Active company names from the Global companies settings — the FEASIBILITY
 *  project company dropdown is sourced from here (owner 2026-06-16). */
export function listCompanies(): string[] {
  const rows = getDb().prepare(
    "SELECT name_th FROM companies WHERE active = 1 ORDER BY name_th COLLATE NOCASE"
  ).all() as Array<{ name_th: string }>;
  return rows.map((r) => r.name_th);
}

/** All projects (shared across admins granted accounta.manage), newest-edited
 *  first, with the cached summary. */
export function listProjects(): FeasibilityProject[] {
  const rows = getDb().prepare(`
    SELECT * FROM feasibility_projects
    ORDER BY (status = 'archived'), updated_at DESC
  `).all() as FeasibilityRow[];
  return rows.map((r) => ({
    ...r,
    inputs: parseInputs(r.inputs),
    summary: parseSummary(r.summary_cache)
  }));
}

/** Load one project (shared — any accounta.manage admin). The second arg is
 *  accepted for call-site compatibility but no longer scopes the read. */
export function getProject(id: number, _userId?: number): FeasibilityProject | null {
  const r = getDb().prepare(
    "SELECT * FROM feasibility_projects WHERE id = ?"
  ).get(id) as FeasibilityRow | undefined;
  if (!r) return null;
  return { ...r, inputs: parseInputs(r.inputs), summary: parseSummary(r.summary_cache) };
}

export type FeasibilityWrite = {
  company: string;
  project_name: string;
  location?: string | null;
  business_type?: string | null;
  status?: FeasibilityStatus;
  inputs: FeasibilityInputs;
};

/** Create a project for the user. Returns the new id. */
export function createProject(userId: number, d: FeasibilityWrite): number {
  const summary = JSON.stringify(summaryOf(d.inputs));
  const info = getDb().prepare(`
    INSERT INTO feasibility_projects
      (created_by, company, project_name, location, business_type, status, inputs, summary_cache)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId, d.company, d.project_name.trim(),
    d.location ?? null, d.business_type ?? null,
    d.status ?? "draft", JSON.stringify(d.inputs), summary
  );
  return Number(info.lastInsertRowid);
}

/** Update a project the user owns. Recomputes the summary cache. */
export function updateProject(id: number, _userId: number, d: FeasibilityWrite): boolean {
  const summary = JSON.stringify(summaryOf(d.inputs));
  const info = getDb().prepare(`
    UPDATE feasibility_projects
    SET company = ?, project_name = ?, location = ?, business_type = ?,
        status = ?, inputs = ?, summary_cache = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    d.company, d.project_name.trim(), d.location ?? null, d.business_type ?? null,
    d.status ?? "draft", JSON.stringify(d.inputs), summary, id
  );
  return info.changes > 0;
}

/** Flip just the status (e.g. archive / un-archive). */
export function setStatus(id: number, _userId: number, status: FeasibilityStatus): boolean {
  const info = getDb().prepare(`
    UPDATE feasibility_projects SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(status, id);
  return info.changes > 0;
}

export function deleteProject(id: number, _userId: number): boolean {
  const info = getDb().prepare(
    "DELETE FROM feasibility_projects WHERE id = ?"
  ).run(id);
  return info.changes > 0;
}

/** Duplicate a project the user owns (or any caller-supplied source row) into
 *  a fresh draft. Used by "คัดลอกเป็นแม่แบบ" + the HYPOPLARAEMIA sample. */
export function duplicateProject(id: number, userId: number): number | null {
  const src = getProject(id, userId);
  if (!src) return null;
  return createProject(userId, {
    company: src.company,
    project_name: `${src.project_name} (สำเนา)`,
    location: src.location,
    business_type: src.business_type,
    status: "draft",
    inputs: src.inputs
  });
}
