import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listExecMeetings } from "@/lib/exec-meetings";
import ExecMeetingsClient, { type StaffLite, type BranchLite } from "./ExecMeetingsClient";

export const dynamic = "force-dynamic";

// ประชุมผู้บริหาร — admin management (owner 2026-09-02). Schedule a meeting and
// invite specific staff; only invitees can join. The invitee picker shows every
// branch of the company side by side (owner 2026-09-02: ซ้าย นามะ ขวา อีเมีย) so
// the whole team is visible at once.
export default function ExecMeetingsPage() {
  const user = requireAdmin();
  const db = getDb();

  // Company of the admin's active branch → show all its branches, each with its
  // own staff column. Each person appears once, under their primary branch.
  const companyId = user.activeBranchId
    ? (db.prepare("SELECT company_id FROM branches WHERE id = ?").get(user.activeBranchId) as { company_id: number | null } | undefined)?.company_id ?? null
    : null;

  const branches: BranchLite[] = companyId != null
    ? (db.prepare("SELECT id, name FROM branches WHERE company_id = ? ORDER BY display_order, name").all(companyId) as BranchLite[])
    : user.activeBranchId
      ? (db.prepare("SELECT id, name FROM branches WHERE id = ?").all(user.activeBranchId) as BranchLite[])
      : [];

  const branchIds = branches.map((b) => b.id);
  const staffRows = branchIds.length > 0
    ? (db.prepare(`
        SELECT u.id, u.display_name, u.title_prefix,
               COALESCE(u.meeting_fee_exempt, 0) AS fee_exempt,
               COALESCE(
                 (SELECT ub.branch_id FROM user_branches ub WHERE ub.user_id = u.id AND ub.is_primary = 1
                    AND ub.branch_id IN (${branchIds.map(() => "?").join(",")}) LIMIT 1),
                 (SELECT MIN(ub.branch_id) FROM user_branches ub WHERE ub.user_id = u.id
                    AND ub.branch_id IN (${branchIds.map(() => "?").join(",")}))
               ) AS branch_id
        FROM users u
        WHERE u.status NOT IN ('disabled', 'resigned', 'terminated')
          AND u.is_test_account = 0
          AND u.role IN ('staff', 'admin')
          AND EXISTS (SELECT 1 FROM user_branches ub WHERE ub.user_id = u.id
                      AND ub.branch_id IN (${branchIds.map(() => "?").join(",")}))
        ORDER BY u.display_name COLLATE NOCASE
      `).all(...branchIds, ...branchIds, ...branchIds) as Array<{ id: number; display_name: string; title_prefix: string | null; fee_exempt: number; branch_id: number | null }>)
    : [];

  const staff: StaffLite[] = staffRows.map((s) => ({
    id: s.id, display_name: s.display_name, title_prefix: s.title_prefix,
    fee_exempt: s.fee_exempt === 1, branchId: s.branch_id ?? (branchIds[0] ?? 0)
  }));

  const meetings = listExecMeetings();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ประชุมผู้บริหาร</h1>
        <p className="text-sm text-slate-500">
          ตั้งการประชุมและเลือกผู้ได้รับเชิญ · เฉพาะผู้ได้รับเชิญเท่านั้นจึงกดเข้าร่วมและได้รับเบี้ยประชุม
        </p>
      </div>
      <ExecMeetingsClient staff={staff} branches={branches} meetings={meetings} />
    </div>
  );
}
