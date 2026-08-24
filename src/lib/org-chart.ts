// Organization chart v2 (owner 2026-08-24). Nodes are PLACEMENTS: the same
// employee can be placed more than once (e.g. branch manager AND head of a
// sub-team), and each placement can sit under MORE THAN ONE parent (matrix /
// dual reporting). Reporting lives in org_chart_edges (node → parent_node).
// See db.ts:org_chart_nodes / org_chart_edges.

import { getDb } from "./db";
import { wouldCreateCycle, type OrgPlacementBase } from "./org-chart-tree";

export type OrgPlacement = OrgPlacementBase;
export { buildOrgForest, wouldCreateCycle, descendantsOf, type OrgTreeNode } from "./org-chart-tree";

const ACTIVE = "u.status NOT IN ('disabled','resigned','terminated') AND u.is_test_account = 0";

/** All placements on a branch's chart (active employees only) + their parents. */
export function listBranchOrgPlacements(branchId: number): OrgPlacement[] {
  const db = getDb();
  const nodes = db.prepare(`
    SELECT o.id AS nodeId, o.user_id AS userId, u.display_name AS displayName, u.title_prefix AS titlePrefix,
           u.nickname_th AS nickname, u.job_title AS jobTitle, u.role AS role,
           o.department AS department, o.sort_order AS sortOrder
      FROM org_chart_nodes o JOIN users u ON u.id = o.user_id
     WHERE o.branch_id = ? AND ${ACTIVE}
     ORDER BY o.sort_order, u.display_name COLLATE NOCASE
  `).all(branchId) as Array<Omit<OrgPlacement, "parentNodeIds">>;
  const edges = db.prepare(
    "SELECT node_id AS nodeId, parent_node_id AS parentNodeId FROM org_chart_edges WHERE branch_id = ?"
  ).all(branchId) as Array<{ nodeId: number; parentNodeId: number }>;
  const parents = new Map<number, number[]>();
  for (const e of edges) {
    if (!parents.has(e.nodeId)) parents.set(e.nodeId, []);
    parents.get(e.nodeId)!.push(e.parentNodeId);
  }
  return nodes.map((n) => ({ ...n, parentNodeIds: parents.get(n.nodeId) ?? [] }));
}

/** Distinct department labels used on a branch (for suggestions). */
export function listBranchDepartments(branchId: number): string[] {
  return (getDb().prepare(`
    SELECT DISTINCT TRIM(department) AS d FROM org_chart_nodes
     WHERE branch_id = ? AND department IS NOT NULL AND TRIM(department) <> ''
     ORDER BY d COLLATE NOCASE
  `).all(branchId) as Array<{ d: string }>).map((r) => r.d);
}

/** Active employees of a branch — eligible to place on the chart. Duplicates
 *  are allowed (a person may already be placed), so nobody is filtered out. */
export function listBranchOrgCandidates(branchId: number): Array<{
  userId: number; displayName: string; titlePrefix: string | null; nickname: string | null; jobTitle: string | null;
}> {
  return getDb().prepare(`
    SELECT u.id AS userId, u.display_name AS displayName, u.title_prefix AS titlePrefix,
           u.nickname_th AS nickname, u.job_title AS jobTitle
      FROM users u JOIN user_branches ub ON ub.user_id = u.id
     WHERE ub.branch_id = ? AND u.role IN ('staff','admin','super_admin') AND ${ACTIVE}
     ORDER BY u.display_name COLLATE NOCASE
  `).all(branchId) as Array<{
    userId: number; displayName: string; titlePrefix: string | null; nickname: string | null; jobTitle: string | null;
  }>;
}

/** Branches of a company (for the branch switcher + company overview). */
export function listCompanyBranchesForOrg(companyId: number): Array<{ id: number; name: string }> {
  return getDb().prepare(
    "SELECT id, name FROM branches WHERE company_id = ? AND status != 'closed' ORDER BY display_order, name"
  ).all(companyId) as Array<{ id: number; name: string }>;
}

// ── Mutations ──────────────────────────────────────────────────────

/** Add a placement for an employee (optionally under a parent node). Verifies
 *  the user is an active member of the branch. Returns the new node id, or null
 *  if the user isn't eligible or the parent isn't on the branch's chart. */
export function addOrgPlacement(branchId: number, userId: number, parentNodeId: number | null): number | null {
  const db = getDb();
  const eligible = db.prepare(`
    SELECT 1 FROM users u JOIN user_branches ub ON ub.user_id = u.id
     WHERE ub.branch_id = ? AND u.id = ? AND u.role IN ('staff','admin','super_admin') AND ${ACTIVE}
  `).get(branchId, userId);
  if (!eligible) return null;
  if (parentNodeId != null && !nodeOnBranch(branchId, parentNodeId)) return null;
  const max = (db.prepare(
    "SELECT COALESCE(MAX(sort_order), 0) AS m FROM org_chart_nodes WHERE branch_id = ?"
  ).get(branchId) as { m: number }).m;
  const info = db.prepare(
    "INSERT INTO org_chart_nodes (branch_id, user_id, sort_order) VALUES (?,?,?)"
  ).run(branchId, userId, max + 10);
  const nodeId = Number(info.lastInsertRowid);
  if (parentNodeId != null) {
    db.prepare(
      "INSERT OR IGNORE INTO org_chart_edges (branch_id, node_id, parent_node_id) VALUES (?,?,?)"
    ).run(branchId, nodeId, parentNodeId);
  }
  return nodeId;
}

/** Remove a placement. Its edges (as child and as parent) cascade, so anyone
 *  reporting only to it is promoted to a root. */
export function removeOrgPlacement(branchId: number, nodeId: number): void {
  getDb().prepare("DELETE FROM org_chart_nodes WHERE id = ? AND branch_id = ?").run(nodeId, branchId);
}

/** Add a parent (manager) edge to a placement. Both nodes must be on the branch;
 *  rejects self and cycles. Returns an error code or null. */
export function addOrgParent(branchId: number, nodeId: number, parentNodeId: number): string | null {
  const db = getDb();
  if (nodeId === parentNodeId) return "self";
  if (!nodeOnBranch(branchId, nodeId)) return "not_on_chart";
  if (!nodeOnBranch(branchId, parentNodeId)) return "manager_not_on_chart";
  if (wouldCreateCycle(listBranchEdges(branchId), nodeId, parentNodeId)) return "cycle";
  db.prepare(
    "INSERT OR IGNORE INTO org_chart_edges (branch_id, node_id, parent_node_id) VALUES (?,?,?)"
  ).run(branchId, nodeId, parentNodeId);
  return null;
}

/** Remove one parent edge from a placement. */
export function removeOrgParent(branchId: number, nodeId: number, parentNodeId: number): void {
  getDb().prepare(
    "DELETE FROM org_chart_edges WHERE branch_id = ? AND node_id = ? AND parent_node_id = ?"
  ).run(branchId, nodeId, parentNodeId);
}

/** Set (or clear) a placement's department label. */
export function setOrgNodeDepartment(branchId: number, nodeId: number, department: string | null): void {
  const dep = department && department.trim() ? department.trim().slice(0, 60) : null;
  getDb().prepare(
    "UPDATE org_chart_nodes SET department = ? WHERE id = ? AND branch_id = ?"
  ).run(dep, nodeId, branchId);
}

function nodeOnBranch(branchId: number, nodeId: number): boolean {
  return !!getDb().prepare("SELECT 1 FROM org_chart_nodes WHERE id = ? AND branch_id = ?").get(nodeId, branchId);
}

function listBranchEdges(branchId: number): Array<{ nodeId: number; parentNodeId: number }> {
  return getDb().prepare(
    "SELECT node_id AS nodeId, parent_node_id AS parentNodeId FROM org_chart_edges WHERE branch_id = ?"
  ).all(branchId) as Array<{ nodeId: number; parentNodeId: number }>;
}
