import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// POST /api/admin/persona/meetings/[id]/items — add a single action item to an
// existing meeting (owner 2026-08-04). Admin-only. Toggling done / deleting an
// item lives under /api/persona/meeting-items/[id].

const HDATE = /^\d{4}-\d{2}-\d{2}$/;
const Body = z.object({
  title: z.string().min(1).max(500),
  assignee_user_id: z.number().int().positive().nullable().optional(),
  due_date: z.string().regex(HDATE).nullable().optional()
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const meetingId = Number(params.id);
  if (!Number.isInteger(meetingId) || meetingId <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { title, assignee_user_id, due_date } = parsed.data;

  const db = getDb();
  const meeting = db.prepare("SELECT id FROM meetings WHERE id = ?").get(meetingId) as { id: number } | undefined;
  if (!meeting) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const nextSort = (db.prepare(
    "SELECT COALESCE(MAX(sort_order), 0) + 10 AS n FROM meeting_action_items WHERE meeting_id = ?"
  ).get(meetingId) as { n: number }).n;

  const res = db.prepare(`
    INSERT INTO meeting_action_items
      (meeting_id, title, assignee_user_id, due_date, status, sort_order, created_at)
    VALUES (?, ?, ?, ?, 'open', ?, ?)
  `).run(meetingId, title.trim(), assignee_user_id ?? null, due_date ?? null, nextSort, new Date().toISOString());

  logPersonaAction(user.id, "meeting.item_add", meetingId);
  return NextResponse.json({ ok: true, id: Number(res.lastInsertRowid) });
}
