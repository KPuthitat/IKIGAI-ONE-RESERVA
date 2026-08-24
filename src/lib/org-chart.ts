// Organization chart (owner 2026-08-24) — a per-branch, editable, multi-level
// org tree with free-text department grouping (e.g. FOH / BOH). Structure comes
// from org_chart_nodes.reports_to_user_id (a manager on the SAME branch's chart);
// NULL reports_to = a root (e.g. branch manager). See db.ts:org_chart_nodes.

import { getDb } from "./db";

export type OrgMember = {
  userId: number;
  displayName: string;
  titlePrefix: string | null;
  nickname: string | null;
  jobTitle: string | null;
  role: string;
  department: string | null;
  reportsToUserId: number | null;
  sortOrder: number;
};

export type OrgTreeNode = OrgMember & { children: OrgTreeNode[] };

const ACTIVE = "u.status NOT IN ('disabled','resigned','terminated') AND u.is_test_account = 0";

/** Members placed on a branch's org chart (active only), sorted for display. */
export function listBranchOrgMembers(branchId: number): OrgMember[] {
  return (getDb().prepare(`
    SELECT o.user_id AS userId, u.display_name AS displayName, u.title_prefix AS titlePrefix,
           u.nickname_th AS nickname, u.job_title AS jobTitle, u.role AS role,
           o.department AS department, o.reports_to_user_id AS reportsToUserId, o.sort_order AS sortOrder
      FROM org_chart_nodes o JOIN users u ON u.id = o.user_id
     WHERE o.branch_id = ? AND ${ACTIVE}
     ORDER BY o.sort_order, u.display_name COLLATE NOCASE
  `).all(branchId) as OrgMember[]);
}

/** Build the forest from reports_to. A member whose manager isn't on the chart
 *  (removed / not added) is promoted to a root so nobody is orphaned. Cycle-safe:
 *  any node whose manager chain loops is promoted to a root instead, so a bad
 *  edge in the data can never make the tree (or its recursive render) infinite. */
export function buildOrgTree(members: OrgMember[]): OrgTreeNode[] {
  const byId = new Map<number, OrgTreeNode>();
  for (const m of members) byId.set(m.userId, { ...m, children: [] });
  // Effective parent = the manager only when they're on the chart and not self.
  const parentOf = (id: number): number | null => {
    const p = byId.get(id)?.reportsToUserId ?? null;
    return p != null && p !== id && byId.has(p) ? p : null;
  };
  const inCycle = (id: number): boolean => {
    const seen = new Set<number>();
    let cur: number | null = id;
    while (cur != null) {
      if (seen.has(cur)) return true;
      seen.add(cur);
      cur = parentOf(cur);
    }
    return false;
  };
  const roots: OrgTreeNode[] = [];
  for (const node of byId.values()) {
    const p = parentOf(node.userId);
    if (p == null || inCycle(node.userId)) roots.push(node);
    else byId.get(p)!.children.push(node);
  }
  const sortRec = (ns: OrgTreeNode[]) => {
    ns.sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName));
    ns.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

/** All (user → manager) edges on a branch's chart, ACTIVE or not — the full set
 *  a cycle check must see (an inactive-but-on-chart node can still form a loop). */
function listBranchOrgEdges(branchId: number): Array<{ userId: number; reportsToUserId: number | null }> {
  return getDb().prepare(
    "SELECT user_id AS userId, reports_to_user_id AS reportsToUserId FROM org_chart_nodes WHERE branch_id = ?"
  ).all(branchId) as Array<{ userId: number; reportsToUserId: number | null }>;
}

/** Distinct department labels already used on a branch (for suggestions). */
export function listBranchDepartments(branchId: number): string[] {
  return (getDb().prepare(`
    SELECT DISTINCT TRIM(department) AS d FROM org_chart_nodes
     WHERE branch_id = ? AND department IS NOT NULL AND TRIM(department) <> ''
     ORDER BY d COLLATE NOCASE
  `).all(branchId) as Array<{ d: string }>).map((r) => r.d);
}

/** Branch employees eligible to add to the chart but not yet on it. */
export function listBranchOrgCandidates(branchId: number): Array<{
  userId: number; displayName: string; titlePrefix: string | null; nickname: string | null; jobTitle: string | null;
}> {
  return getDb().prepare(`
    SELECT u.id AS userId, u.display_name AS displayName, u.title_prefix AS titlePrefix,
           u.nickname_th AS nickname, u.job_title AS jobTitle
      FROM users u JOIN user_branches ub ON ub.user_id = u.id
     WHERE ub.branch_id = ? AND u.role IN ('staff','admin','super_admin') AND ${ACTIVE}
       AND u.id NOT IN (SELECT user_id FROM org_chart_nodes WHERE branch_id = ?)
     ORDER BY u.display_name COLLATE NOCASE
  `).all(branchId, branchId) as Array<{
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

/** Add an employee to a branch's chart (no-op if already there). Verifies the
 *  user actually belongs to the branch. Returns false if not a branch member. */
export function addOrgMember(branchId: number, userId: number): boolean {
  const db = getDb();
  // Must be an active EMPLOYEE assigned to this branch — same rule as the
  // candidate list, enforced here so a raw POST can't add an ineligible user.
  const eligible = db.prepare(`
    SELECT 1 FROM users u JOIN user_branches ub ON ub.user_id = u.id
     WHERE ub.branch_id = ? AND u.id = ? AND u.role IN ('staff','admin','super_admin') AND ${ACTIVE}
  `).get(branchId, userId);
  if (!eligible) return false;
  const max = (db.prepare(
    "SELECT COALESCE(MAX(sort_order), 0) AS m FROM org_chart_nodes WHERE branch_id = ?"
  ).get(branchId) as { m: number }).m;
  db.prepare(
    "INSERT OR IGNORE INTO org_chart_nodes (branch_id, user_id, sort_order) VALUES (?,?,?)"
  ).run(branchId, userId, max + 10);
  return true;
}

/** Remove an employee from a branch's chart; anyone reporting to them on this
 *  branch is re-parented to a root (reports_to set NULL). */
export function removeOrgMember(branchId: number, userId: number): void {
  const db = getDb();
  db.prepare(
    "UPDATE org_chart_nodes SET reports_to_user_id = NULL WHERE branch_id = ? AND reports_to_user_id = ?"
  ).run(branchId, userId);
  db.prepare("DELETE FROM org_chart_nodes WHERE branch_id = ? AND user_id = ?").run(branchId, userId);
}

/** Pure: would making `managerId` the manager of `userId` create a cycle? True
 *  if managerId is userId itself or a descendant of userId in `members`. */
export function wouldCreateCycle(
  members: Array<{ userId: number; reportsToUserId: number | null }>,
  userId: number, managerId: number
): boolean {
  if (managerId === userId) return true;
  const childrenOf = new Map<number, number[]>();
  for (const m of members) {
    if (m.reportsToUserId != null) {
      if (!childrenOf.has(m.reportsToUserId)) childrenOf.set(m.reportsToUserId, []);
      childrenOf.get(m.reportsToUserId)!.push(m.userId);
    }
  }
  // BFS descendants of userId; if managerId is among them, it's a cycle.
  const stack = [...(childrenOf.get(userId) ?? [])];
  const seen = new Set<number>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === managerId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(childrenOf.get(cur) ?? []));
  }
  return false;
}

/** Set (or clear with null) a member's manager. Both must be on the branch's
 *  chart; rejects self-reference and cycles. Returns an error code or null. */
export function setOrgManager(branchId: number, userId: number, managerId: number | null): string | null {
  const db = getDb();
  const onChart = (id: number) =>
    !!db.prepare("SELECT 1 FROM org_chart_nodes WHERE branch_id = ? AND user_id = ?").get(branchId, id);
  if (!onChart(userId)) return "not_on_chart";
  if (managerId != null) {
    if (!onChart(managerId)) return "manager_not_on_chart";
    // Cycle check over ALL on-chart edges (incl inactive) — an inactive node in
    // the chain could still close a loop that later resurfaces on rehire.
    if (wouldCreateCycle(listBranchOrgEdges(branchId), userId, managerId)) return "cycle";
  }
  db.prepare(
    "UPDATE org_chart_nodes SET reports_to_user_id = ? WHERE branch_id = ? AND user_id = ?"
  ).run(managerId, branchId, userId);
  return null;
}

/** Set (or clear with null/blank) a member's department label. */
export function setOrgDepartment(branchId: number, userId: number, department: string | null): void {
  const dep = department && department.trim() ? department.trim().slice(0, 60) : null;
  getDb().prepare(
    "UPDATE org_chart_nodes SET department = ? WHERE branch_id = ? AND user_id = ?"
  ).run(dep, branchId, userId);
}
