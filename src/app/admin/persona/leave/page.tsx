import { requireAdmin } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { computeStretch } from "@/lib/leave";
import LeaveAdminClient, { type LeaveAdminRow, type StaffOption } from "./LeaveAdminClient";

export const dynamic = "force-dynamic";

type StatusFilter = "pending" | "approved" | "rejected" | "cancelled" | "revision_requested" | "all" | "special";

// Per-branch since 2026-05 (Phase 2): leave_requests filtered by
// branch_id matching the admin's currently-active branch. Same staff
// who works at both branches will have separate request streams.
export default function AdminLeavePage({
  searchParams
}: {
  searchParams: { status?: string };
}) {
  const user = requireAdmin();
  const lang = getLang();
  const db = getDb();

  if (!user.activeBranchId) {
    return (
      <div className="card text-sm text-slate-600">
        {t(lang, "admin.notAssignedBranch")}
      </div>
    );
  }
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) {
    return <div className="card text-sm text-slate-600">{t(lang, "common.error")}</div>;
  }

  const status: StatusFilter =
    ["pending", "approved", "rejected", "cancelled", "revision_requested", "all", "special"].includes(searchParams.status ?? "")
      ? (searchParams.status as StatusFilter)
      : "pending";

  // Branch filter is always present; status filter stacks on top of it.
  const params: Array<string | number> = [branch.id];
  let whereClause = "WHERE r.branch_id = ?";
  if (status === "special") {
    whereClause += " AND r.is_special_request = 1 AND r.status = 'pending'";
  } else if (status !== "all") {
    whereClause += " AND r.status = ?";
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

  // Status counters scoped to this branch — the tabs in the client
  // show "(N)" badges that should match what the table will render.
  const counts = db.prepare(`
    SELECT status, COUNT(*) AS n FROM leave_requests
    WHERE branch_id = ?
    GROUP BY status
  `).all(branch.id) as Array<{ status: string; n: number }>;
  const countMap = Object.fromEntries(counts.map(c => [c.status, c.n])) as Record<string, number>;
  const specialCount = (db.prepare(
    "SELECT COUNT(*) AS n FROM leave_requests WHERE branch_id = ? AND is_special_request = 1 AND status = 'pending'"
  ).get(branch.id) as { n: number }).n;
  countMap.special = specialCount;

  // Staff list for "file leave on behalf of" — only people assigned
  // to this branch (admin shouldn't be filing on behalf of staff at
  // the other branch).
  const staffList = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.role
    FROM users u
    INNER JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?
    WHERE u.role = 'staff'
    ORDER BY CASE WHEN u.employment_type = 'ft' THEN 0 WHEN u.employment_type = 'pt' THEN 1 ELSE 2 END,
             u.display_name
  `).all(branch.id) as StaffOption[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.leave.title")}
          <span className="ml-2 text-sm font-medium text-brand">· {branch.name}</span>
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
