import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { setMeetingFeeBranch } from "@/lib/exec-meetings";

// เบี้ยประชุมลงสาขาไหน (owner 2026-09-29) — set/clear the per-meeting branch a
// person's meeting fee books to. branch_id null = clear (back to home branch).

const Body = z.object({
  user_id: z.number().int().positive(),
  branch_id: z.number().int().positive().nullable()
});

function gateAdmin() {
  const user = getSessionUser();
  if (!user) return { error: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
  if (user.role !== "admin" && user.role !== "super_admin") {
    return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { user };
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const gate = gateAdmin();
  if (gate.error) return gate.error;
  const meetingId = Number(params.id);
  if (!Number.isInteger(meetingId)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });

  const err = setMeetingFeeBranch(meetingId, parsed.data.user_id, parsed.data.branch_id);
  if (err) return NextResponse.json({ error: err }, { status: err === "not_invited" ? 404 : 400 });
  logPersonaAction(gate.user.id, "exec_meeting.fee_branch", meetingId);
  return NextResponse.json({ ok: true });
}
