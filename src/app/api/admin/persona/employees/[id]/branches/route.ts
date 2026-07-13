import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// POST /api/admin/persona/employees/[id]/branches
//
// Sets which branches an employee may enter (their user_branches
// membership). This is the staff-access counterpart to the branch
// ADMIN grants done on /admin/companies — so it must NOT clobber
// is_admin: a branch the caller keeps for the user is left exactly
// as it was (is_admin preserved).
//
// Scope: a sub-admin can only add/remove branches they administer
// (user.adminBranchIds). super_admin can touch every branch. Any
// branch outside the caller's scope is left untouched, so a sub-
// admin can never strip access another admin/super_admin granted
// elsewhere.

const Body = z.object({
  branch_ids: z.array(z.number().int().positive()).max(100)
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const me = getSessionUser();
  if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (me.role !== "admin" && me.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const db = getDb();
  const target = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!target) return NextResponse.json({ error: "user_not_found" }, { status: 404 });

  // Branches the caller is allowed to change.
  const editable = new Set<number>(
    me.role === "super_admin"
      ? (db.prepare("SELECT id FROM branches").all() as Array<{ id: number }>).map((b) => b.id)
      : me.adminBranchIds
  );
  // Only branches that both exist and are in the caller's scope.
  const desired = new Set<number>(
    parsed.data.branch_ids.filter((b) => editable.has(b))
  );

  const current = new Set<number>(
    (db.prepare(
      "SELECT branch_id FROM user_branches WHERE user_id = ?"
    ).all(id) as Array<{ branch_id: number }>).map((r) => r.branch_id)
  );

  const toAdd: number[] = [];
  const toRemove: number[] = [];
  for (const b of editable) {
    const want = desired.has(b);
    const has = current.has(b);
    if (want && !has) toAdd.push(b);
    else if (!want && has) toRemove.push(b);
    // want && has → leave the row (is_admin preserved)
  }

  if (toAdd.length === 0 && toRemove.length === 0) {
    return NextResponse.json({ ok: true, added: 0, removed: 0 });
  }

  const txn = db.transaction(() => {
    const ins = db.prepare(
      "INSERT OR IGNORE INTO user_branches (user_id, branch_id, is_admin) VALUES (?, ?, 0)"
    );
    for (const b of toAdd) ins.run(id, b);
    const del = db.prepare(
      "DELETE FROM user_branches WHERE user_id = ? AND branch_id = ?"
    );
    for (const b of toRemove) del.run(id, b);
  });
  txn();

  logPersonaAction(me.id, "user.branch_access", id);
  return NextResponse.json({ ok: true, added: toAdd.length, removed: toRemove.length });
}
