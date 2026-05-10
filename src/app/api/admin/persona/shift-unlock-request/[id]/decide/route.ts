import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb } from "@/lib/db";

// POST /api/admin/persona/shift-unlock-request/[id]/decide
//
// Admin grants or rejects a staff's request to redo a shift_open
// report. Granting deletes the original daily_reports row (which
// cascades through the shift_unlock_requests FK), so staff can
// open the shift form again and re-submit. Rejecting just marks
// the request as 'rejected' — no DB cleanup, the staff sees the
// locked view as before.

const Body = z.object({
  decision: z.enum(["granted", "rejected"])
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
    SELECT r.id, r.daily_report_id, r.status, dr.branch_id
    FROM shift_unlock_requests r
    LEFT JOIN daily_reports dr ON dr.id = r.daily_report_id
    WHERE r.id = ?
  `).get(id) as
    | { id: number; daily_report_id: number; status: string; branch_id: number | null }
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

  const nowIso = new Date().toISOString();
  const tx = db.transaction(() => {
    if (parsed.data.decision === "granted") {
      // Delete the original report; the FK ON DELETE CASCADE on
      // shift_unlock_requests would also drop sibling requests.
      // Update this request first to record the decision before the
      // cascade removes it — though SQLite would complete in one
      // transaction either way, doing UPDATE-then-DELETE preserves
      // a tidy audit trail when admin pulls historical reports.
      db.prepare(`
        UPDATE shift_unlock_requests
        SET status = 'granted', decided_by = ?, decided_at = ?
        WHERE id = ?
      `).run(user.id, nowIso, id);
      db.prepare("DELETE FROM daily_reports WHERE id = ?").run(row.daily_report_id);
    } else {
      // Reject: leave the daily_reports row alone. Staff stays in
      // locked view; they can either accept it or file a fresh
      // request with a clearer reason.
      db.prepare(`
        UPDATE shift_unlock_requests
        SET status = 'rejected', decided_by = ?, decided_at = ?
        WHERE id = ?
      `).run(user.id, nowIso, id);
    }
  });
  tx();

  return NextResponse.json({ ok: true, decision: parsed.data.decision });
}
