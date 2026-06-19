import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import OtApprovalsClient, { type OtRow, type OtStaff } from "./OtApprovalsClient";

export const dynamic = "force-dynamic";

// /admin/persona/ot-approvals — supervisor/admin approves or rejects
// staff overtime requests. Approved OT credits the "ทำงานล่วงเวลา"
// column at payroll time (owner 2026-06-03). Admins can also ADD OT
// directly for a staff member (owner 2026-06-14) — see AddOtForm.
export default function OtApprovalsPage() {
  const user = requireAdmin();
  const db = getDb();

  // Staff in the admin's active branch — targets for the "add OT" form.
  // Scoped to the active branch because the add API records OT against it.
  const staff = (user.activeBranchId
    ? db.prepare(`
        SELECT DISTINCT u.id, u.display_name, u.title_prefix, u.employment_type
        FROM users u
        INNER JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?
        WHERE u.status NOT IN ('disabled', 'resigned', 'terminated')
          AND u.employment_type IN ('pt', 'ft')
          AND u.is_test_account = 0
        ORDER BY CASE WHEN u.employment_type = 'ft' THEN 0 ELSE 1 END, u.display_name
      `).all(user.activeBranchId)
    : []) as OtStaff[];

  const rows = db.prepare(`
    SELECT o.id, o.user_id, o.work_date, o.requested_until, o.status,
           o.created_at, o.decided_at,
           u.display_name, u.title_prefix,
           b.name AS branch_name,
           du.display_name AS decided_by_name
    FROM ot_requests o
    JOIN users u ON u.id = o.user_id
    LEFT JOIN branches b ON b.id = o.branch_id
    LEFT JOIN users du ON du.id = o.decided_by
    ORDER BY CASE WHEN o.status = 'pending' THEN 0 ELSE 1 END,
             o.work_date DESC, o.id DESC
    LIMIT 400
  `).all() as OtRow[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">อนุมัติการทำงานล่วงเวลา</h1>
        <p className="text-sm text-slate-500">
          คำขอ OT จากพนักงาน — อนุมัติแล้วระบบจะนำไปคิดในคอลัมน์ &quot;ทำงานล่วงเวลา&quot; ตอนคำนวณเงินเดือน
        </p>
      </div>
      <OtApprovalsClient rows={rows} staff={staff} />
    </div>
  );
}
