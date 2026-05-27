import { requireAdmin } from "@/lib/auth";
import { getDb, getSystemSettings } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import ResignationAdminClient, { type ResignationAdminRow } from "./ResignationAdminClient";

export const dynamic = "force-dynamic";

type StatusFilter = "pending" | "approved" | "rejected" | "cancelled" | "all";

export default function AdminResignationPage({
  searchParams
}: {
  searchParams: { status?: string };
}) {
  requireAdmin();
  const lang = getLang();
  const db = getDb();

  const status: StatusFilter =
    ["pending", "approved", "rejected", "cancelled", "all"].includes(searchParams.status ?? "")
      ? (searchParams.status as StatusFilter)
      : "pending";

  const params: Array<string | number> = [];
  let whereClause = "";
  if (status !== "all") {
    whereClause = "WHERE r.status = ?";
    params.push(status);
  }

  const requests = db.prepare(`
    SELECT r.id, r.user_id, r.proposed_last_day, r.computed_min_last_day,
           r.reason, r.evidence_filename, r.is_special_request,
           r.status, r.decided_by, r.decided_at, r.decision_note, r.created_at, r.ref_no,
           u.username, u.display_name, u.title_prefix, u.hire_date,
           du.display_name AS decided_by_name,
           du.title_prefix AS decided_by_prefix
    FROM resignation_requests r
    JOIN users u ON r.user_id = u.id
    LEFT JOIN users du ON r.decided_by = du.id
    ${whereClause}
    ORDER BY r.created_at DESC
    LIMIT 200
  `).all(...params) as ResignationAdminRow[];

  const counts = db.prepare(`
    SELECT status, COUNT(*) AS n FROM resignation_requests GROUP BY status
  `).all() as Array<{ status: string; n: number }>;
  const countMap = Object.fromEntries(counts.map(c => [c.status, c.n])) as Record<string, number>;

  // staff list สำหรับ unlock dropdown
  const staffList = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.title_prefix,
           u.resignation_unlocked_at,
           uu.display_name AS unlocked_by_name
    FROM users u
    LEFT JOIN users uu ON u.resignation_unlocked_by = uu.id
    WHERE u.role = 'staff'
    ORDER BY CASE WHEN u.employment_type = 'ft' THEN 0 WHEN u.employment_type = 'pt' THEN 1 ELSE 2 END,
             u.display_name
  `).all() as Array<{
    id: number; username: string; display_name: string; title_prefix: string | null;
    resignation_unlocked_at: string | null;
    unlocked_by_name: string | null;
  }>;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.resignation.title")}
        </h1>
        <p className="text-sm text-slate-500">
          {t(lang, "admin.persona.resignation.subtitle")}
        </p>
      </div>
      <ResignationAdminClient
        currentStatus={status}
        countMap={countMap}
        requests={requests}
        staffList={staffList}
        improperResignationConsequences={getSystemSettings().improper_resignation_consequences}
      />
    </div>
  );
}
