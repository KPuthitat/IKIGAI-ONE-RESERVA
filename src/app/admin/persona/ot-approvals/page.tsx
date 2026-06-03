import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import OtApprovalsClient, { type OtRow } from "./OtApprovalsClient";

export const dynamic = "force-dynamic";

// /admin/persona/ot-approvals — supervisor/admin approves or rejects
// staff overtime requests. Approved OT credits the "ทำงานล่วงเวลา"
// column at payroll time (owner 2026-06-03).
export default function OtApprovalsPage() {
  requireAdmin();
  const db = getDb();

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
    LIMIT 100
  `).all() as OtRow[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">อนุมัติทำงานล่วงเวลา (OT)</h1>
        <p className="text-sm text-slate-500">
          คำขอ OT จากพนักงาน — อนุมัติแล้วระบบจะนำไปคิดในคอลัมน์ &quot;ทำงานล่วงเวลา&quot; ตอนคำนวณเงินเดือน
        </p>
      </div>
      <OtApprovalsClient rows={rows} />
    </div>
  );
}
