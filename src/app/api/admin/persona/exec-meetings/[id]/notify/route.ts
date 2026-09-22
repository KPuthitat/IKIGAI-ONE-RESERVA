import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { getMeetingInvitees } from "@/lib/exec-meetings";
import { notifyMeetingInvitees } from "@/lib/exec-meeting-notify";

// POST /api/admin/persona/exec-meetings/[id]/notify — re-send the LINE invite
// to ALL current invitees (owner 2026-09-25). Used after a reschedule, an
// agenda change, or any edit. The card is rebuilt from the meeting's live data
// (date/time/agenda), so recipients always get the latest details.

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const invitees = getMeetingInvitees(id);
  if (invitees.length === 0) return NextResponse.json({ error: "no_invitees" }, { status: 400 });

  const sent = await notifyMeetingInvitees(id, invitees.map((p) => p.user_id));
  logPersonaAction(user.id, "exec_meeting.renotify", id);
  if (sent === 0) {
    // Nobody was reachable: OA not configured, or no invitee has a bound LINE.
    return NextResponse.json({ error: "none_delivered", message: "ส่งไม่ได้ — ยังไม่ได้ตั้งค่า LINE OA หรือผู้ได้รับเชิญยังไม่ได้ผูก LINE" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, count: sent });
}
