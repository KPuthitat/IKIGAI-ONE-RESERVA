import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { createExecMeeting, listExecMeetings, type ExecMeetingStatus } from "@/lib/exec-meetings";
import { notifyMeetingInvitees } from "@/lib/exec-meeting-notify";

// ประชุมผู้บริหาร — admin management (owner 2026-09-02).
//   GET  → list meetings (optionally by status)
//   POST → create a meeting + its invitee set

const HDATE = /^\d{4}-\d{2}-\d{2}$/;

const Body = z.object({
  title: z.string().min(1).max(200),
  meeting_date: z.string().regex(HDATE),
  company_wide: z.boolean().optional(),
  scheduled_at: z.string().max(40).nullable().optional(),
  agenda_topics: z.array(z.string().max(300)).max(50).optional(),
  invitee_user_ids: z.array(z.number().int().positive()).max(200).default([])
});

function requireAdmin() {
  const user = getSessionUser();
  if (!user) return { error: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
  if (user.role !== "admin" && user.role !== "super_admin") {
    return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { user };
}

export async function GET(req: Request) {
  const gate = requireAdmin();
  if (gate.error) return gate.error;
  const status = new URL(req.url).searchParams.get("status") as ExecMeetingStatus | null;
  const valid = new Set(["scheduled", "active", "ended", "closed"]);
  return NextResponse.json({
    meetings: listExecMeetings(status && valid.has(status) ? { status } : {})
  });
}

export async function POST(req: Request) {
  const gate = requireAdmin();
  if (gate.error) return gate.error;
  const user = gate.user;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  if (!d.company_wide && user.activeBranchId == null) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }
  const branchId = d.company_wide ? null : user.activeBranchId;

  const id = createExecMeeting({
    title: d.title,
    meeting_date: d.meeting_date,
    branch_id: branchId,
    scheduled_at: d.scheduled_at ?? null,
    agenda_topics: d.agenda_topics,
    invitee_user_ids: d.invitee_user_ids,
    created_by: user.id
  });
  logPersonaAction(user.id, "exec_meeting.create", id);
  // LINE นัดประชุมถึงผู้ได้รับเชิญทันที (owner 2026-09-02) — fire-and-forget.
  void notifyMeetingInvitees(id, d.invitee_user_ids);
  return NextResponse.json({ ok: true, id });
}
