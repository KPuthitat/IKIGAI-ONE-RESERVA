import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// CRUD for roster positions (TC-R). Soft-delete (active=0) for the
// same reason shift_codes is — positions are the row labels of the
// monthly grid + are FK targets from historic roster_assignments.

const CreateBody = z.object({
  title: z.string().trim().min(1).max(60),
  description: z.string().trim().max(1000).nullable().optional(),
  display_order: z.number().int().min(0).max(999).optional()
});
const UpdateBody = CreateBody.partial().extend({
  id: z.number().int().positive(),
  active: z.boolean().optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  if (!userHasBranch(user, user.activeBranchId)) return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });

  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;
  const db = getDb();
  const r = db.prepare(`
    INSERT INTO roster_positions (branch_id, title, description, display_order, active)
    VALUES (?, ?, ?, ?, 1)
  `).run(
    user.activeBranchId,
    d.title.trim(),
    d.description?.trim() || null,
    d.display_order ?? 0
  );
  const id = Number(r.lastInsertRowid);
  logPersonaAction(user.id, "roster.position.create", id);
  return NextResponse.json({ ok: true, id });
}

export async function PATCH(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });

  const parsed = UpdateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;
  const db = getDb();
  const target = db.prepare("SELECT branch_id FROM roster_positions WHERE id = ?").get(d.id) as { branch_id: number } | undefined;
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (target.branch_id !== user.activeBranchId) return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });

  const sets: string[] = [];
  const vals: Array<string | number | null> = [];
  if (d.title !== undefined)         { sets.push("title = ?");         vals.push(d.title.trim()); }
  if (d.description !== undefined)   { sets.push("description = ?");   vals.push(d.description?.trim() || null); }
  if (d.display_order !== undefined) { sets.push("display_order = ?"); vals.push(d.display_order); }
  if (d.active !== undefined)        { sets.push("active = ?");        vals.push(d.active ? 1 : 0); }
  if (sets.length === 0) return NextResponse.json({ error: "no_fields" }, { status: 400 });
  vals.push(d.id);
  db.prepare(`UPDATE roster_positions SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  logPersonaAction(user.id, "roster.position.update", d.id);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });

  const url = new URL(req.url);
  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const db = getDb();
  const target = db.prepare("SELECT branch_id FROM roster_positions WHERE id = ?").get(id) as { branch_id: number } | undefined;
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (target.branch_id !== user.activeBranchId) return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  db.prepare("UPDATE roster_positions SET active = 0 WHERE id = ?").run(id);
  logPersonaAction(user.id, "roster.position.delete", id);
  return NextResponse.json({ ok: true });
}
