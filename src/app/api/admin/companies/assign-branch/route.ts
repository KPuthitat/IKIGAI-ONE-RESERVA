import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// POST /api/admin/companies/assign-branch — super_admin moves a
// branch under a company (or detaches it with company_id = null).
// Kept separate from the branch settings endpoint because this is a
// tenant-level (super_admin) action, not a per-branch admin one.

const Body = z.object({
  branch_id: z.number().int().positive(),
  company_id: z.number().int().positive().nullable()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden_super_admin_only" }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const db = getDb();

  const branch = db.prepare("SELECT id FROM branches WHERE id = ?").get(parsed.data.branch_id);
  if (!branch) return NextResponse.json({ error: "branch_not_found" }, { status: 404 });

  if (parsed.data.company_id !== null) {
    const company = db.prepare("SELECT id FROM companies WHERE id = ?").get(parsed.data.company_id);
    if (!company) return NextResponse.json({ error: "company_not_found" }, { status: 404 });
  }

  db.prepare("UPDATE branches SET company_id = ? WHERE id = ?").run(
    parsed.data.company_id,
    parsed.data.branch_id
  );
  logPersonaAction(user.id, "branch.assign_company", parsed.data.branch_id);
  return NextResponse.json({ ok: true });
}
