import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanAdminBranch, type SessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// PATCH /api/admin/persona/meetings/[id] — edit a meeting's title/date/summary.
// DELETE — remove a meeting (its action items cascade). Admin-only, and
// branch-scoped: an admin may only touch meetings of a branch they administer
// (company-wide meetings, branch_id NULL, are open to any admin). Mirrors the
// shift-checklist route's branch guard — prevents editing another branch's
// meeting by guessing its id (IDOR).

// company-wide (branch_id NULL) → any admin; else must administer that branch.
const canManageBranch = (user: SessionUser, branchId: number | null) =>
  branchId == null || userCanAdminBranch(user, branchId);

const HDATE = /^\d{4}-\d{2}-\d{2}$/;
const Body = z.object({
  title: z.string().min(1).max(200).optional(),
  meeting_date: z.string().regex(HDATE).optional(),
  summary: z.string().max(20000).optional()
});

function guard() {
  const user = getSessionUser();
  if (!user) return { err: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
  if (user.role !== "admin" && user.role !== "super_admin") {
    return { err: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { user };
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const g = guard();
  if (g.err) return g.err;
  const user = g.user;

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;

  const db = getDb();
  const row = db.prepare("SELECT id, branch_id FROM meetings WHERE id = ?")
    .get(id) as { id: number; branch_id: number | null } | undefined;
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!canManageBranch(user, row.branch_id)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (d.title !== undefined) { sets.push("title = ?"); vals.push(d.title.trim()); }
  if (d.meeting_date !== undefined) { sets.push("meeting_date = ?"); vals.push(d.meeting_date); }
  if (d.summary !== undefined) { sets.push("summary = ?"); vals.push(d.summary.trim()); }
  if (sets.length === 0) return NextResponse.json({ ok: true });

  vals.push(id);
  db.prepare(`UPDATE meetings SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  logPersonaAction(user.id, "meeting.edit", id);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const g = guard();
  if (g.err) return g.err;
  const user = g.user;

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  const row = db.prepare("SELECT id, branch_id FROM meetings WHERE id = ?")
    .get(id) as { id: number; branch_id: number | null } | undefined;
  if (!row) return NextResponse.json({ ok: true, deleted: 0 });
  if (!canManageBranch(user, row.branch_id)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }
  const r = db.prepare("DELETE FROM meetings WHERE id = ?").run(id); // items cascade
  if (r.changes > 0) logPersonaAction(user.id, "meeting.delete", id);
  return NextResponse.json({ ok: true, deleted: r.changes });
}
