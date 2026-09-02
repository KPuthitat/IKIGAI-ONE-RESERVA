import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import {
  getExecMeeting, updateExecMeeting, deleteExecMeeting, setInvitees, type ExecMeetingStatus
} from "@/lib/exec-meetings";

// ประชุมผู้บริหาร — one meeting (owner 2026-09-02).
//   GET    → full detail (invitees + attendance + minutes status)
//   PATCH  → edit title/date/status and/or replace invitees
//   DELETE → remove the meeting (cascades)

const HDATE = /^\d{4}-\d{2}-\d{2}$/;

const Patch = z.object({
  title: z.string().min(1).max(200).optional(),
  meeting_date: z.string().regex(HDATE).optional(),
  company_wide: z.boolean().optional(),
  status: z.enum(["scheduled", "active", "ended", "closed"]).optional(),
  invitee_user_ids: z.array(z.number().int().positive()).max(200).optional()
});

function gateAdmin() {
  const user = getSessionUser();
  if (!user) return { error: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
  if (user.role !== "admin" && user.role !== "super_admin") {
    return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { user };
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const gate = gateAdmin();
  if (gate.error) return gate.error;
  const m = getExecMeeting(Number(params.id));
  if (!m) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ meeting: m });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const gate = gateAdmin();
  if (gate.error) return gate.error;
  const id = Number(params.id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const parsed = Patch.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  const branch_id = d.company_wide === undefined
    ? undefined
    : (d.company_wide ? null : gate.user.activeBranchId ?? null);

  const changed = updateExecMeeting(id, {
    title: d.title,
    meeting_date: d.meeting_date,
    branch_id,
    status: d.status as ExecMeetingStatus | undefined
  });
  if (d.invitee_user_ids) setInvitees(id, d.invitee_user_ids);
  if (!changed && !d.invitee_user_ids) return NextResponse.json({ error: "no_change" }, { status: 400 });
  logPersonaAction(gate.user.id, "exec_meeting.update", id);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const gate = gateAdmin();
  if (gate.error) return gate.error;
  const ok = deleteExecMeeting(Number(params.id));
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  logPersonaAction(gate.user.id, "exec_meeting.delete", Number(params.id));
  return NextResponse.json({ ok: true });
}
