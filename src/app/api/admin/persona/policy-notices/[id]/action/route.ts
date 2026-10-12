import { NextResponse } from "next/server";
import { z } from "zod";
import { logPersonaAction } from "@/lib/db";
import { cancelNotice, closeNotice, getNotice, inviteMeeting, listItems, publish, remindPending } from "@/lib/policy-notices";
import { letterFlex, meetingInviteFlex } from "@/lib/policy-notices-notify";
import { pushIndividually } from "@/lib/special-duty-notify";
import { adminGate, errorResponse } from "@/lib/policy-notices-api";

// POST {action: invite | publish | remind | close | cancel}
//   invite  → announce the meeting to every employee in scope (LINE, one message each)
//   publish → lock the letter and send it for acknowledgement
//   remind  → re-send the letter to people who have not pressed รับทราบ
//   close   → stop collecting acknowledgements
//   cancel  → drop a notice that never went out as a letter

const Body = z.object({ action: z.enum(["invite", "publish", "remind", "close", "cancel"]) });

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const g = adminGate(); if ("error" in g) return g.error;
  const id = Number(params.id);
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  const base = (process.env.NEXT_PUBLIC_PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const url = `${base}/staff/persona/policy-notices`;
  try {
    const action = parsed.data.action;
    let recipients: Array<{ lineUserId: string | null }> = [];
    let flex = null as ReturnType<typeof letterFlex> | null;
    if (action === "invite") {
      recipients = inviteMeeting(id);
      const n = getNotice(id)!;
      flex = meetingInviteFlex({ title: n.title, meetingAt: n.meetingAt!, location: n.location, purpose: n.purpose, url });
    } else if (action === "publish" || action === "remind") {
      recipients = action === "publish" ? publish(id) : remindPending(id);
      const n = getNotice(id)!;
      flex = letterFlex({ title: n.title, topics: listItems(id).map((i) => i.topic), ackDeadline: n.ackDeadline, reminder: action === "remind", url });
    } else if (action === "close") closeNotice(id);
    else cancelNotice(id);
    logPersonaAction(g.user.id, `policy_notice_${action}`, id);
    // The state change above is committed before any message goes out; a LINE failure never undoes it.
    const pushed = flex ? await pushIndividually(recipients.map((r) => r.lineUserId), flex) : 0;
    return NextResponse.json({ ok: true, recipients: recipients.length, pushed, noLine: recipients.filter((r) => !r.lineUserId).length });
  } catch (e) { return errorResponse(e); }
}
