import { NextResponse } from "next/server";
import { z } from "zod";
import { logPersonaAction } from "@/lib/db";
import { adminDetail, cleanItems, saveItems, updateNotice } from "@/lib/policy-notices";
import { adminGate, errorResponse, NoticeBody } from "@/lib/policy-notices-api";

// GET → notice + topics + per-person acknowledgement state (admin only)
// PUT {…notice fields, items:[{topic,details,suggestions}]} → save meeting details and the whole list of topics.
//     Refused (409 locked) once the letter has been published.

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const g = adminGate(); if ("error" in g) return g.error;
  const d = adminDetail(Number(params.id));
  if (!d) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, ...d });
}

const Body = NoticeBody.extend({
  items: z.array(z.object({ topic: z.string(), details: z.string(), suggestions: z.string().optional() })).max(30)
});

export async function PUT(req: Request, { params }: { params: { id: string } }) {
  const g = adminGate(); if ("error" in g) return g.error;
  const id = Number(params.id);
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  const d = parsed.data;
  try {
    const items = d.items.map((i) => ({ topic: i.topic, details: i.details, suggestions: i.suggestions ?? "" }));
    cleanItems(items);   // validate before touching anything, so a bad topic leaves the meeting details unchanged too
    updateNotice(id, { title: d.title, purpose: d.purpose, meetingAt: d.meeting_at ?? null, location: d.location, announcer: d.announcer, branchId: d.branch_id ?? null, ackDeadline: d.ack_deadline ?? null });
    saveItems(id, items);
    logPersonaAction(g.user.id, "policy_notice_save", id);
    return NextResponse.json({ ok: true });
  } catch (e) { return errorResponse(e); }
}
