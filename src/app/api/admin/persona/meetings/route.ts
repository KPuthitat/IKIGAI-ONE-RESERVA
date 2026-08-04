import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// POST /api/admin/persona/meetings — create a meeting summary + its action
// items in one shot (owner 2026-08-04). branch_id defaults to the admin's
// active branch; company_wide=true stores NULL (ประชุมระดับบริษัท). Each action
// item may be assigned to a staff member and given a due date.

const HDATE = /^\d{4}-\d{2}-\d{2}$/;

const ItemInput = z.object({
  title: z.string().min(1).max(500),
  assignee_user_id: z.number().int().positive().nullable().optional(),
  due_date: z.string().regex(HDATE).nullable().optional()
});

const Body = z.object({
  title: z.string().min(1).max(200),
  meeting_date: z.string().regex(HDATE),
  summary: z.string().max(20000).optional(),
  company_wide: z.boolean().optional(),
  items: z.array(ItemInput).max(100).optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { title, meeting_date, summary, company_wide, items } = parsed.data;

  const branchId = company_wide ? null : (user.activeBranchId ?? null);
  const db = getDb();
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    const res = db.prepare(`
      INSERT INTO meetings (branch_id, title, meeting_date, summary, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(branchId, title.trim(), meeting_date, (summary ?? "").trim(), user.id, now);
    const meetingId = Number(res.lastInsertRowid);

    if (items && items.length) {
      const insItem = db.prepare(`
        INSERT INTO meeting_action_items
          (meeting_id, title, assignee_user_id, due_date, status, sort_order, created_at)
        VALUES (?, ?, ?, ?, 'open', ?, ?)
      `);
      items.forEach((it, i) => {
        if (!it.title.trim()) return;
        insItem.run(meetingId, it.title.trim(), it.assignee_user_id ?? null, it.due_date ?? null, (i + 1) * 10, now);
      });
    }
    return meetingId;
  });
  const id = tx();

  logPersonaAction(user.id, "meeting.create", id);
  return NextResponse.json({ ok: true, id });
}
