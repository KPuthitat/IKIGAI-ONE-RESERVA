import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { summarizeMeeting, precheckSummary, setSummaryStatus, MeetingAiError } from "@/lib/exec-meeting-ai";

// POST /api/admin/persona/exec-meetings/[id]/summarize — kick off the AI summary.
// A detailed summary can take longer than the reverse-proxy timeout, so the work
// runs in the BACKGROUND: we validate + mark "running" + return immediately, and
// the UI polls the meeting until ai_status flips to done/error (owner 2026-09-02).
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const id = Number(params.id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  try {
    precheckSummary(id);  // fast checks — reject a bad request synchronously
  } catch (e) {
    if (e instanceof MeetingAiError) return NextResponse.json({ error: e.code, message: e.message }, { status: 400 });
    return NextResponse.json({ error: "unknown", message: (e as Error).message }, { status: 500 });
  }

  setSummaryStatus(id, "running");
  logPersonaAction(user.id, "exec_meeting.summarize", id);
  // Fire-and-forget: the Node process (pm2) keeps running after the response, so
  // the summary finishes and writes its result even though we've replied.
  void summarizeMeeting(id).catch((e) => {
    const msg = e instanceof MeetingAiError ? e.message : "สรุปไม่สำเร็จ ลองใหม่อีกครั้ง";
    try { setSummaryStatus(id, "error", msg); } catch { /* ignore */ }
  });
  return NextResponse.json({ ok: true, started: true });
}
