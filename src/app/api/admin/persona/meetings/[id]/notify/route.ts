import { NextResponse } from "next/server";
import { getSessionUser, userCanAdminBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { notifyMeetingChecklist } from "@/lib/meetings-notify";

// POST /api/admin/persona/meetings/[id]/notify — post the meeting's checklist
// (open items) to the linked staff LINE group (owner 2026-09-05). Admin-only,
// branch-scoped. Per-item completion pings are automatic elsewhere; this is the
// admin-triggered "share the whole checklist now" action.

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const meetingId = Number(params.id);
  if (!Number.isInteger(meetingId) || meetingId <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const meeting = db.prepare("SELECT id, branch_id FROM meetings WHERE id = ?")
    .get(meetingId) as { id: number; branch_id: number | null } | undefined;
  if (!meeting) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (meeting.branch_id != null && !userCanAdminBranch(user, meeting.branch_id)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }

  const result = await notifyMeetingChecklist(db, meetingId);
  if (result.ok) logPersonaAction(user.id, "meeting.checklist_notify", meetingId);
  // Map the notify reason to an HTTP shape the client can message.
  if (!result.ok) {
    const status = result.reason === "empty" ? 400 : result.reason === "no_group" ? 409 : 502;
    return NextResponse.json({ ok: false, reason: result.reason }, { status });
  }
  return NextResponse.json({ ok: true });
}
