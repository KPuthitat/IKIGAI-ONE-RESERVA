import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import LeaveAdminClient, { type LeaveAdminRow } from "./LeaveAdminClient";

export const dynamic = "force-dynamic";

type StatusFilter = "pending" | "approved" | "rejected" | "cancelled" | "all";

export default function AdminLeavePage({
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
    SELECT r.id, r.user_id, r.type, r.date_from, r.date_to, r.days, r.reason,
           r.status, r.decided_by, r.decided_at, r.decision_note, r.created_at,
           u.username, u.display_name,
           du.display_name AS decided_by_name
    FROM leave_requests r
    JOIN users u ON r.user_id = u.id
    LEFT JOIN users du ON r.decided_by = du.id
    ${whereClause}
    ORDER BY r.created_at DESC
    LIMIT 200
  `).all(...params) as LeaveAdminRow[];

  // Counts for filter pills
  const counts = db.prepare(`
    SELECT status, COUNT(*) AS n FROM leave_requests GROUP BY status
  `).all() as Array<{ status: string; n: number }>;
  const countMap = Object.fromEntries(counts.map(c => [c.status, c.n])) as Record<string, number>;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.leave.title")}
        </h1>
        <p className="text-sm text-slate-500">
          {t(lang, "admin.persona.leave.subtitle")}
        </p>
      </div>
      <LeaveAdminClient
        currentStatus={status}
        countMap={countMap}
        requests={requests}
      />
    </div>
  );
}
