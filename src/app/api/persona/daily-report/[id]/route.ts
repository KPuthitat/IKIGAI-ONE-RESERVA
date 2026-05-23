import { NextResponse } from "next/server";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, type DailyReportType } from "@/lib/db";

// GET /api/persona/daily-report/[id]
//
// Staff-facing read endpoint for the report-detail viewer that lives
// inside the locked-screen view (ShiftReportLocked.tsx). Lets staff
// re-check what they just submitted before deciding whether to file
// an unlock request.
//
// Auth contract: any of
//   - the staff who SUBMITTED this report (user_id match)
//   - any admin/super_admin who's assigned to the report's branch
//
// Mirrors the slim shape returned by the admin sibling at
// /api/admin/persona/daily-report/[id]. We keep them as two
// endpoints (not one) because the admin route has a stricter auth
// model — collapsing them would couple staff-visible UX to admin
// role logic and make future divergence risky.

type Row = {
  id: number;
  type: DailyReportType;
  branch_id: number;
  user_id: number;
  report_date: string;
  created_at: string;
  data: string;
  replaces_id: number | null;
  opener_name: string;
  opener_prefix: string | null;
};

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const row = db.prepare(`
    SELECT r.id, r.type, r.branch_id, r.user_id, r.report_date, r.created_at,
           r.data, r.replaces_id,
           u.display_name AS opener_name,
           u.title_prefix AS opener_prefix
    FROM daily_reports r
    JOIN users u ON u.id = r.user_id
    WHERE r.id = ?
  `).get(id) as Row | undefined;
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Owner OR (admin in the report's branch). Staff at other branches
  // can't peek at this report — same shape as the rest of PERSONA's
  // branch-scoped access.
  const isOwner = row.user_id === user.id;
  const isBranchAdmin =
    (user.role === "admin" || user.role === "super_admin")
    && userHasBranch(user, row.branch_id);
  if (!isOwner && !isBranchAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(row.data);
  } catch {
    return NextResponse.json({ error: "corrupt_data" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    report: {
      id: row.id,
      type: row.type,
      report_date: row.report_date,
      created_at: row.created_at,
      opener_name: row.opener_name,
      opener_prefix: row.opener_prefix,
      is_revision: row.replaces_id != null,
      data
    }
  });
}
