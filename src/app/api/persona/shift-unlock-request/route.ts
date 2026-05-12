import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction, type Branch } from "@/lib/db";
import { shiftUnlockRequestFlex, notifyToStaffGroup } from "@/lib/line";

// POST /api/persona/shift-unlock-request — staff asks admin to unlock
// any submitted daily_report (shift_open / shift_close / readiness_*)
// so they can re-submit. Inserts a row in shift_unlock_requests +
// pushes a Flex card to the staff LINE group so admin sees the
// request inline. Admin acts via /admin/persona/shift-reports.

const Body = z.object({
  daily_report_id: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500)
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { daily_report_id, reason } = parsed.data;

  const db = getDb();

  // Resolve the report so we can verify the branch + push to the
  // right LINE group. The unlock request is meaningless without
  // the report; rejecting unknown ids stops accidental garbage.
  // We don't filter by type here — staff can request edits on any
  // of the 4 report types (open, close, readiness 11:30, 16:00).
  const report = db.prepare(`
    SELECT r.id, r.type, r.branch_id, r.report_date, r.user_id,
           u.display_name AS opener_name
    FROM daily_reports r JOIN users u ON r.user_id = u.id
    WHERE r.id = ?
  `).get(daily_report_id) as
    | { id: number; type: string; branch_id: number; report_date: string; user_id: number; opener_name: string }
    | undefined;
  if (!report) return NextResponse.json({ error: "report_not_found" }, { status: 404 });

  // Branch guard — same pattern as the other PERSONA endpoints. The
  // staff making the request must be assigned to that branch (otherwise
  // they have no business asking for an unlock there).
  if (!userHasBranch(user, report.branch_id)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }

  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(report.branch_id) as Branch | undefined;
  if (!branch) return NextResponse.json({ error: "branch_not_found" }, { status: 404 });

  // Block obvious dupes — if this same user already has a pending
  // request on this report, don't spam the LINE group with another
  // card. They can wait for admin to act on the first one.
  const dup = db.prepare(`
    SELECT id FROM shift_unlock_requests
    WHERE daily_report_id = ? AND requested_by = ? AND status = 'pending'
  `).get(daily_report_id, user.id) as { id: number } | undefined;
  if (dup) {
    return NextResponse.json({ error: "already_requested", id: dup.id }, { status: 409 });
  }

  const insertedAt = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO shift_unlock_requests
      (daily_report_id, requested_by, reason, status, created_at)
    VALUES (?, ?, ?, 'pending', ?)
  `).run(daily_report_id, user.id, reason, insertedAt);
  const requestId = result.lastInsertRowid as number;

  // Audit log — staff filed an unlock request; ref_id is the new
  // request row. The action verb includes the report type so admin
  // can filter the audit screen later if needed.
  logPersonaAction(
    user.id,
    `shift_unlock_request.create.${report.type}`,
    requestId
  );

  // Push Flex notification to staff group — fire-and-forget; log error
  // but don't block the response. Admin sees the card in the same group
  // where the original shift-open card landed.
  const flex = shiftUnlockRequestFlex({
    branchName: branch.name,
    reportDate: report.report_date,
    reportType: report.type as
      | "shift_open" | "shift_close" | "readiness_1130" | "readiness_1600",
    openerName: report.opener_name,
    requesterName: user.display_name,
    reason
  });
  notifyToStaffGroup(branch, flex, "global").catch((e) =>
    console.error("notify shift-unlock-request error", e)
  );

  return NextResponse.json({ ok: true, id: requestId });
}
