import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { summarizeMeeting, MeetingAiError } from "@/lib/exec-meeting-ai";

// POST /api/admin/persona/exec-meetings/[id]/summarize — ask the AI to summarise
// the attendees' minutes into a summary + follow-up checklist + carryover.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const id = Number(params.id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  try {
    const result = await summarizeMeeting(id);
    logPersonaAction(user.id, "exec_meeting.summarize", id);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof MeetingAiError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: 400 });
    }
    return NextResponse.json({ error: "unknown", message: (e as Error).message }, { status: 500 });
  }
}
