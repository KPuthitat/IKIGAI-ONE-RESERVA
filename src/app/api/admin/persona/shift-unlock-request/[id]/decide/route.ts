import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { shiftUnlockDecisionFlex, notifyDailyReport } from "@/lib/line";

// POST /api/admin/persona/shift-unlock-request/[id]/decide
//
// Admin grants or rejects a staff's request to redo a shift_open
// report. Granting deletes the original daily_reports row (which
// cascades through the shift_unlock_requests FK), so staff can
// open the shift form again and re-submit. Rejecting marks the
// request as 'rejected' + optionally records a decision_note,
// then notifies the staff group via LINE so the requester knows
// why before they file again.

const Body = z.object({
  decision: z.enum(["granted", "rejected"]),
  decision_note: z.string().trim().max(500).optional()
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const db = getDb();

  // Resolve the request + its underlying report so we can branch-guard
  // and (on grant) cascade-delete cleanly. Joining daily_reports here
  // makes the missing-row case obvious — no point letting admin "grant"
  // a request whose report has already been deleted by another admin.
  const row = db.prepare(`
    SELECT r.id, r.daily_report_id, r.status, r.requested_by, r.reason,
           dr.branch_id, dr.report_date, dr.user_id AS opener_id,
           u.display_name AS requester_name,
           ou.display_name AS opener_name
    FROM shift_unlock_requests r
    LEFT JOIN daily_reports dr ON dr.id = r.daily_report_id
    LEFT JOIN users u ON u.id = r.requested_by
    LEFT JOIN users ou ON ou.id = dr.user_id
    WHERE r.id = ?
  `).get(id) as
    | {
        id: number; daily_report_id: number; status: string;
        requested_by: number; reason: string;
        branch_id: number | null; report_date: string | null;
        opener_id: number | null;
        requester_name: string | null;
        opener_name: string | null;
      }
    | undefined;
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (row.status !== "pending") {
    return NextResponse.json(
      { error: "already_decided", currentStatus: row.status },
      { status: 409 }
    );
  }
  if (row.branch_id != null && !userHasBranch(user, row.branch_id)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }

  const note = parsed.data.decision_note?.trim() || null;
  const nowIso = new Date().toISOString();
  const tx = db.transaction(() => {
    if (parsed.data.decision === "granted") {
      // Update the request first to record the decision, then delete
      // the daily_reports row (FK ON DELETE CASCADE on
      // shift_unlock_requests would also drop sibling requests on the
      // same report). Doing UPDATE-then-DELETE preserves a tidy audit
      // trail when admin pulls historical reports later.
      db.prepare(`
        UPDATE shift_unlock_requests
        SET status = 'granted', decided_by = ?, decided_at = ?, decision_note = ?
        WHERE id = ?
      `).run(user.id, nowIso, note, id);
      db.prepare("DELETE FROM daily_reports WHERE id = ?").run(row.daily_report_id);
    } else {
      // Reject: leave the daily_reports row alone. Staff stays in
      // locked view; they can either accept it or file a fresh
      // request with a clearer reason.
      db.prepare(`
        UPDATE shift_unlock_requests
        SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ?
        WHERE id = ?
      `).run(user.id, nowIso, note, id);
    }
  });
  tx();

  // Push a Flex card to the staff LINE group so the requester knows
  // the outcome immediately — covers both grant and reject. Skipped
  // silently if branch info couldn't be resolved (corrupt row).
  if (row.branch_id != null && row.report_date && row.requester_name) {
    const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
      .get(row.branch_id) as Branch | undefined;
    if (branch) {
      const flex = shiftUnlockDecisionFlex({
        branchName: branch.name,
        reportDate: row.report_date,
        requesterName: row.requester_name,
        adminName: user.display_name,
        decision: parsed.data.decision,
        decisionNote: note
      });
      notifyDailyReport(branch, flex).catch((e) =>
        console.error("notify shift-unlock-decision error", e)
      );
    }
  }

  return NextResponse.json({ ok: true, decision: parsed.data.decision });
}
