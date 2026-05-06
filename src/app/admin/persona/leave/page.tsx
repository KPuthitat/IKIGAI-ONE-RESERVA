import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { computeStretch } from "@/lib/leave";
import LeaveAdminClient, { type LeaveAdminRow, type StaffOption } from "./LeaveAdminClient";

export const dynamic = "force-dynamic";

type StatusFilter = "pending" | "approved" | "rejected" | "cancelled" | "revision_requested" | "all" | "special";

export default function AdminLeavePage({
  searchParams
}: {
  searchParams: { status?: string };
}) {
  requireAdmin();
  const lang = getLang();
  const db = getDb();

  const status: StatusFilter =
    ["pending", "approved", "rejected", "cancelled", "revision_requested", "all", "special"].includes(searchParams.status ?? "")
      ? (searchParams.status as StatusFilter)
      : "pending";

  const params: Array<string | number> = [];
  let whereClause = "";
  if (status === "special") {
    whereClause = "WHERE r.is_special_request = 1 AND r.status = 'pending'";
  } else if (status !== "all") {
    whereClause = "WHERE r.status = ?";
    params.push(status);
  }

  const rawRequests = db.prepare(`
    SELECT r.id, r.user_id, r.type, r.date_from, r.date_to, r.days, r.hours, r.reason,
           r.evidence_filename, r.status, r.decided_by, r.decided_at, r.decision_note,
           r.created_by, r.created_at, r.is_special_request, r.replaces_id, r.ref_no,
           (SELECT ref_no FROM leave_requests WHERE id = r.replaces_id) AS replaces_ref_no,
           (SELECT id FROM leave_requests WHERE replaces_id = r.id ORDER BY id DESC LIMIT 1) AS resubmitted_as_id,
           (SELECT ref_no FROM leave_requests WHERE replaces_id = r.id ORDER BY id DESC LIMIT 1) AS resubmitted_as_ref_no,
           u.username, u.display_name,
           du.display_name AS decided_by_name,
           cu.display_name AS created_by_name
    FROM leave_requests r
    JOIN users u ON r.user_id = u.id
    LEFT JOIN users du ON r.decided_by = du.id
    LEFT JOIN users cu ON r.created_by = cu.id
    ${whereClause}
    ORDER BY r.created_at DESC
    LIMIT 200
  `).all(...params) as Omit<LeaveAdminRow, "stretchTotal" | "stretchHolidayCount" | "advanceDays">[];

  // เพิ่ม stretch info เฉพาะ personal/annual
  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const todayMs = new Date(`${todayBkk}T00:00:00Z`).getTime();
  const requests: LeaveAdminRow[] = rawRequests.map((r) => {
    if (r.type === "personal" || r.type === "annual") {
      const s = computeStretch(r.date_from, r.date_to);
      const fromMs = new Date(`${r.date_from}T00:00:00Z`).getTime();
      const advanceDaysAtCreation = Math.floor(
        (fromMs - new Date(`${r.created_at.slice(0, 10)}T00:00:00Z`).getTime()) / 86400000
      );
      return {
        ...r,
        stretchTotal: s.totalConsecutive,
        stretchHolidayCount: s.prepended.length + s.appended.length,
        advanceDays: advanceDaysAtCreation
      };
    }
    return { ...r, stretchTotal: null, stretchHolidayCount: null, advanceDays: null };
  });

  const counts = db.prepare(`
    SELECT status, COUNT(*) AS n FROM leave_requests GROUP BY status
  `).all() as Array<{ status: string; n: number }>;
  const countMap = Object.fromEntries(counts.map(c => [c.status, c.n])) as Record<string, number>;
  const specialCount = (db.prepare(
    "SELECT COUNT(*) AS n FROM leave_requests WHERE is_special_request = 1 AND status = 'pending'"
  ).get() as { n: number }).n;
  countMap.special = specialCount;

  // staff list สำหรับ "ลงวันลาให้พนักงาน"
  const staffList = db.prepare(`
    SELECT id, username, display_name, role
    FROM users
    WHERE role = 'staff'
    ORDER BY display_name
  `).all() as StaffOption[];

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
        staffList={staffList}
      />
    </div>
  );
}
