import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanAdminBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// PATCH /api/persona/meeting-items/[id] — mark an action item done / reopen it.
// Allowed for the item's ASSIGNEE (so staff can close their own work) or any
// admin (owner 2026-08-04).
// DELETE — remove the item; admin-only.

const Body = z.object({ action: z.enum(["done", "reopen"]) });

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }

  const db = getDb();
  const item = db.prepare(`
    SELECT ai.id, ai.assignee_user_id, m.branch_id
    FROM meeting_action_items ai
    JOIN meetings m ON m.id = ai.meeting_id
    WHERE ai.id = ?
  `).get(id) as { id: number; assignee_user_id: number | null; branch_id: number | null } | undefined;
  if (!item) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // The item's assignee may always close/reopen their own task. An admin may too,
  // but only for a branch they administer (company-wide meetings open to any admin).
  const isAssignee = item.assignee_user_id === user.id;
  const isAdmin = (user.role === "admin" || user.role === "super_admin")
    && (item.branch_id == null || userCanAdminBranch(user, item.branch_id));
  if (!isAdmin && !isAssignee) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (parsed.data.action === "done") {
    db.prepare(
      "UPDATE meeting_action_items SET status = 'done', done_at = ?, done_by = ? WHERE id = ?"
    ).run(new Date().toISOString(), user.id, id);
    logPersonaAction(user.id, "meeting.item_done", id);
  } else {
    db.prepare(
      "UPDATE meeting_action_items SET status = 'open', done_at = NULL, done_by = NULL WHERE id = ?"
    ).run(id);
    logPersonaAction(user.id, "meeting.item_reopen", id);
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  const item = db.prepare(`
    SELECT ai.id, m.branch_id
    FROM meeting_action_items ai
    JOIN meetings m ON m.id = ai.meeting_id
    WHERE ai.id = ?
  `).get(id) as { id: number; branch_id: number | null } | undefined;
  if (!item) return NextResponse.json({ ok: true, deleted: 0 });
  if (item.branch_id != null && !userCanAdminBranch(user, item.branch_id)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }
  const r = db.prepare("DELETE FROM meeting_action_items WHERE id = ?").run(id);
  if (r.changes > 0) logPersonaAction(user.id, "meeting.item_delete", id);
  return NextResponse.json({ ok: true, deleted: r.changes });
}
