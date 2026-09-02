import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { getStaffMeetingView, joinMeeting, saveMinutes, endMeeting } from "@/lib/exec-meetings";

// Staff-facing single meeting.
//   GET  → this staff member's view (invited? joined? minutes? fee?)
//   POST → { action: "join" | "minutes" | "end", ...minutes fields }

const ERR_MSG: Record<string, string> = {
  not_found: "ไม่พบการประชุม",
  meeting_not_active: "การประชุมยังไม่เปิด หรือปิดไปแล้ว",
  not_invited: "คุณไม่ได้รับเชิญเข้าประชุมนี้",
  still_clocked_in: "กรุณาลงเวลาออกงานให้เรียบร้อยก่อนเข้าร่วมประชุม",
  already_joined: "คุณเข้าร่วมประชุมนี้อยู่แล้ว",
  already_ended: "คุณสิ้นสุดการประชุมนี้ไปแล้ว",
  not_joined: "ยังไม่ได้กดเข้าร่วมประชุม",
  minutes_incomplete: "กรอกรายงานการประชุมให้ครบทั้ง 4 ช่องก่อนสิ้นสุดการประชุม"
};

const Body = z.object({
  action: z.enum(["join", "minutes", "end"]),
  agenda: z.string().max(5000).optional(),
  details: z.string().max(20000).optional(),
  suggestions: z.string().max(20000).optional(),
  action_plan: z.string().max(20000).optional()
});

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const view = getStaffMeetingView(Number(params.id), user.id);
  if (!view) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ meeting: view });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const id = Number(params.id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const d = parsed.data;

  if (d.action === "join") {
    const err = joinMeeting(id, user.id);
    if (err) return NextResponse.json({ error: err, message: ERR_MSG[err] ?? err }, { status: 400 });
    logPersonaAction(user.id, "exec_meeting.join", id);
    return NextResponse.json({ ok: true });
  }

  if (d.action === "minutes") {
    const err = saveMinutes(id, user.id, {
      agenda: d.agenda ?? "", details: d.details ?? "",
      suggestions: d.suggestions ?? "", action_plan: d.action_plan ?? ""
    });
    if (err) return NextResponse.json({ error: err, message: ERR_MSG[err] ?? err }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  // end
  const res = endMeeting(id, user.id);
  if ("error" in res) {
    return NextResponse.json({ error: res.error, message: ERR_MSG[res.error] ?? res.error }, { status: 400 });
  }
  logPersonaAction(user.id, "exec_meeting.end", id);
  return NextResponse.json({ ok: true, minutes: res.minutes, fee: res.fee });
}
