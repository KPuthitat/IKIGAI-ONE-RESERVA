import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listAllAccountaAccess, setAccountaAccess, type AccessLevel } from "@/lib/accounta-access";

// GET  /api/admin/accounta/access — matrix data (users × branches + grants)
// POST /api/admin/accounta/access — set one user's level on one branch
// super_admin only (it governs who can touch each branch's accounting).

const Body = z.object({
  user_id: z.number().int().positive(),
  branch_id: z.number().int().positive(),
  level: z.enum(["none", "view", "confirm"])
});

export function GET() {
  requireSuperAdmin();
  const db = getDb();
  // Rows = people who could process accounting: active admins (incl. super_admin).
  const users = db.prepare(`
    SELECT id, display_name, title_prefix, role FROM users
     WHERE role IN ('admin','super_admin') AND status NOT IN ('disabled','resigned','terminated')
     ORDER BY role = 'super_admin' DESC, display_name COLLATE NOCASE
  `).all();
  const branches = db.prepare("SELECT id, name FROM branches ORDER BY id").all();
  return NextResponse.json({ ok: true, users, branches, grants: listAllAccountaAccess() });
}

export async function POST(req: Request) {
  const me = requireSuperAdmin();
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  setAccountaAccess(d.user_id, d.branch_id, d.level as AccessLevel, me.id);
  return NextResponse.json({ ok: true, grants: listAllAccountaAccess() });
}
