import { NextResponse } from "next/server";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, type DailyReportType } from "@/lib/db";

// GET /api/admin/persona/daily-report/[id]
//
// Returns the full payload of a daily report so a supervisor can
// inspect what their staff actually submitted today — the live
// shift-reports listing only shows "✓ done at HH:MM by whom"; this
// endpoint exposes the underlying checklist values + numeric fields
// (drawer amounts, etc.) so admin can verify without scrolling LINE
// history.
//
// Branch-guarded: admin must belong to the report's branch, mirrors
// the resend-notification endpoint's auth pattern. Returns a slim
// shape — only the fields the detail UI actually renders, not the
// raw row (which has irrelevant columns like superseded_at).
//
// We DON'T attach the chain (revision history) here — that's already
// available via the chains data on the shift-reports page. This
// endpoint is purely "what's IN this one row".

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
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
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

  if (!userHasBranch(user, row.branch_id)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
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
