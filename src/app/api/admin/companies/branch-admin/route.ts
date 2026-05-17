import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// POST /api/admin/companies/branch-admin — super_admin sets (or
// clears) a user as an administrator of a specific branch.
//
// Granting: ensures a user_branches row exists with is_admin = 1,
// and promotes a plain 'staff' account to 'admin' so requireAdmin
// will actually let them into the console (a super_admin keeps its
// global role; an existing 'admin' is untouched).
//
// Revoking: flips is_admin back to 0 but keeps the membership row,
// so the person can still work that branch as ordinary staff and
// their admin rights on other branches are unaffected.

const Body = z.object({
  branch_id: z.number().int().positive(),
  user_id: z.number().int().positive(),
  is_admin: z.boolean()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden_super_admin_only" }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const { branch_id, user_id, is_admin } = parsed.data;
  const db = getDb();

  const branch = db.prepare("SELECT id FROM branches WHERE id = ?").get(branch_id);
  if (!branch) return NextResponse.json({ error: "branch_not_found" }, { status: 404 });
  const target = db.prepare("SELECT id, role FROM users WHERE id = ?").get(user_id) as
    | { id: number; role: string }
    | undefined;
  if (!target) return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  if (target.role === "super_admin") {
    return NextResponse.json(
      { error: "user_is_super_admin" },
      { status: 400 }
    );
  }

  const txn = db.transaction(() => {
    if (is_admin) {
      db.prepare(
        `INSERT INTO user_branches (user_id, branch_id, is_admin)
         VALUES (?, ?, 1)
         ON CONFLICT(user_id, branch_id) DO UPDATE SET is_admin = 1`
      ).run(user_id, branch_id);
      // A branch admin must be role='admin' for requireAdmin to pass.
      if (target.role === "staff") {
        db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user_id);
      }
    } else {
      db.prepare(
        "UPDATE user_branches SET is_admin = 0 WHERE user_id = ? AND branch_id = ?"
      ).run(user_id, branch_id);
    }
  });
  txn();
  logPersonaAction(user.id, is_admin ? "branch.admin_grant" : "branch.admin_revoke", branch_id);
  return NextResponse.json({ ok: true });
}
