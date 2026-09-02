import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listExecMeetings } from "@/lib/exec-meetings";
import ExecMeetingsClient, { type StaffLite } from "./ExecMeetingsClient";

export const dynamic = "force-dynamic";

// ประชุมผู้บริหาร — admin management (owner 2026-09-02). Schedule a meeting and
// invite specific staff; only invitees can join. Attendance + minutes + AI
// summary + เบี้ยประชุม are handled in later phases.
export default function ExecMeetingsPage() {
  const user = requireAdmin();
  const db = getDb();

  // Staff eligible to be invited: active people at the admin's active branch.
  const staff = user.activeBranchId
    ? (db.prepare(`
        SELECT u.id, u.display_name, u.title_prefix,
               COALESCE(u.meeting_fee_exempt, 0) AS fee_exempt
        FROM users u
        INNER JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?
        WHERE u.status NOT IN ('disabled', 'resigned', 'terminated')
          AND u.is_test_account = 0
          AND u.role IN ('staff', 'admin')
        ORDER BY u.display_name COLLATE NOCASE
      `).all(user.activeBranchId) as Array<{ id: number; display_name: string; title_prefix: string | null; fee_exempt: number }>)
    : [];

  const staffLite: StaffLite[] = staff.map((s) => ({
    id: s.id, display_name: s.display_name, title_prefix: s.title_prefix, fee_exempt: s.fee_exempt === 1
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
      <ExecMeetingsClient staff={staffLite} meetings={meetings} />
    </div>
  );
}
