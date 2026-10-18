// Staff list for the grouped recipient picker (branch columns → departments → people).
// Shared by the executive-meeting invitees and the policy-notice audience.
import { getDb } from "./db";

export type StaffLite = {
  id: number;
  display_name: string;
  title_prefix: string | null;
  fee_exempt: boolean;
  isCLevel: boolean;
  isAdmin: boolean;
  branchId: number;
  department: string | null;
};
export type BranchLite = { id: number; name: string };

/** Company of the admin's active branch → all its branches, each person once under their primary branch. */
export function loadPickerStaff(activeBranchId: number | null): { staff: StaffLite[]; branches: BranchLite[] } {
  const db = getDb();
  const companyId = activeBranchId
    ? (db.prepare("SELECT company_id FROM branches WHERE id = ?").get(activeBranchId) as { company_id: number | null } | undefined)?.company_id ?? null
    : null;

  const branches: BranchLite[] = companyId != null
    ? (db.prepare("SELECT id, name FROM branches WHERE company_id = ? ORDER BY display_order, name").all(companyId) as BranchLite[])
    : activeBranchId
      ? (db.prepare("SELECT id, name FROM branches WHERE id = ?").all(activeBranchId) as BranchLite[])
      : [];

  const branchIds = branches.map((b) => b.id);
  if (branchIds.length === 0) return { staff: [], branches };
  const ph = branchIds.map(() => "?").join(",");
  const staffRows = db.prepare(`
    SELECT u.id, u.display_name, u.title_prefix, u.role,
           COALESCE(u.meeting_fee_exempt, 0) AS fee_exempt,
           COALESCE(u.is_c_level, 0) AS is_c_level,
           COALESCE(
             (SELECT ub.branch_id FROM user_branches ub WHERE ub.user_id = u.id AND ub.is_primary = 1
                AND ub.branch_id IN (${ph}) LIMIT 1),
             (SELECT MIN(ub.branch_id) FROM user_branches ub WHERE ub.user_id = u.id
                AND ub.branch_id IN (${ph}))
           ) AS branch_id
    FROM users u
    WHERE u.status NOT IN ('disabled', 'resigned', 'terminated')
      AND u.is_test_account = 0
      AND u.role IN ('staff', 'admin')
      AND EXISTS (SELECT 1 FROM user_branches ub WHERE ub.user_id = u.id AND ub.branch_id IN (${ph}))
    ORDER BY u.display_name COLLATE NOCASE
  `).all(...branchIds, ...branchIds, ...branchIds) as Array<{ id: number; display_name: string; title_prefix: string | null; role: string; fee_exempt: number; is_c_level: number; branch_id: number | null }>;

  // Department = org-chart placement at that branch, keyed `${userId}|${branchId}`.
  const deptOf = new Map<string, string>();
  for (const n of db.prepare(
    `SELECT user_id, branch_id, department FROM org_chart_nodes WHERE branch_id IN (${ph})`
  ).all(...branchIds) as Array<{ user_id: number; branch_id: number; department: string | null }>) {
    if (n.department && n.department.trim()) deptOf.set(`${n.user_id}|${n.branch_id}`, n.department.trim());
  }

  const staff = staffRows.map((s): StaffLite => {
    const branchId = s.branch_id ?? branchIds[0];
    return {
      id: s.id, display_name: s.display_name, title_prefix: s.title_prefix,
      fee_exempt: s.fee_exempt === 1, isCLevel: s.is_c_level === 1, isAdmin: s.role === "admin",
      branchId, department: deptOf.get(`${s.id}|${branchId}`) ?? null
    };
  });
  return { staff, branches };
}
