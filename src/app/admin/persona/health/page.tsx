import { requireAdmin } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import HealthClient, { type HealthRow } from "./HealthClient";

export const dynamic = "force-dynamic";

// /admin/persona/health — employee health check-up tracker
// (food-handler certificate / แบบ ส.ณ.11). Per-branch like the
// employees page: shows staff in the admin's active branch with their
// latest cert + valid/expiring/expired status, and lets admin record a
// new check-up. Disabled accounts are excluded.
export default function AdminHealthPage() {
  const user = requireAdmin();
  const db = getDb();

  if (!user.activeBranchId) {
    return (
      <div className="card text-sm text-slate-600">
        ยังไม่ได้เลือกสาขา
      </div>
    );
  }
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) {
    return <div className="card text-sm text-slate-600">เกิดข้อผิดพลาด</div>;
  }

  // Latest check-up per employee via a correlated subquery on the
  // health_checkups (user_id, checkup_date DESC) index.
  const rows = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.title_prefix, u.role, u.employment_type,
           hc.id          AS checkup_id,
           hc.checkup_date AS checkup_date,
           hc.expiry_date  AS expiry_date,
           hc.overall_result AS overall_result,
           hc.clinic_name  AS clinic_name,
           hc.doctor_name  AS doctor_name,
           hc.cert_no      AS cert_no,
           hc.items_json   AS items_json,
           hc.attachment_url AS attachment_url,
           hc.notes        AS notes
    FROM users u
    INNER JOIN user_branches ub
      ON ub.user_id = u.id AND ub.branch_id = ?
    LEFT JOIN health_checkups hc ON hc.id = (
      SELECT id FROM health_checkups
      WHERE user_id = u.id
      ORDER BY checkup_date DESC, id DESC
      LIMIT 1
    )
    WHERE u.status != 'disabled'
    ORDER BY u.role DESC,
             CASE WHEN u.employment_type = 'ft' THEN 0
                  WHEN u.employment_type = 'pt' THEN 1 ELSE 2 END,
             u.display_name ASC
  `).all(branch.id) as HealthRow[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          ผลตรวจสุขภาพพนักงาน
          <span className="ml-2 text-sm font-medium text-brand">· {branch.name}</span>
        </h1>
        <p className="text-sm text-slate-500">
          ติดตามใบรับรองแพทย์ผู้สัมผัสอาหาร (แบบ ส.ณ.11) — แจ้งเตือนเมื่อใกล้หมดอายุ
        </p>
      </div>
      <HealthClient rows={rows} />
    </div>
  );
}
