import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// POST /api/admin/companies/assign-branch — super_admin edits a
// branch's tenant-level fields: which company it belongs to (or
// null = unassigned), its registered address and tax branch code
// (used on government paperwork — ใบกำกับภาษี / หนังสือราชการ),
// and its display name. Kept separate from the per-branch settings
// endpoint because this is a tenant-level (super_admin) action.

const Body = z.object({
  branch_id: z.number().int().positive(),
  company_id: z.number().int().positive().nullable().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  reg_address: z.string().trim().max(1000).nullable().optional(),
  tax_branch_code: z.string().trim().max(10).nullable().optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden_super_admin_only" }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const d = parsed.data;
  const db = getDb();

  const branch = db.prepare("SELECT id FROM branches WHERE id = ?").get(d.branch_id);
  if (!branch) return NextResponse.json({ error: "branch_not_found" }, { status: 404 });

  if (d.company_id != null) {
    const company = db.prepare("SELECT id FROM companies WHERE id = ?").get(d.company_id);
    if (!company) return NextResponse.json({ error: "company_not_found" }, { status: 404 });
  }

  const sets: string[] = [];
  const vals: Array<string | number | null> = [];
  if (d.company_id !== undefined) { sets.push("company_id = ?"); vals.push(d.company_id); }
  if (d.name !== undefined) { sets.push("name = ?"); vals.push(d.name); }
  if (d.reg_address !== undefined) {
    sets.push("reg_address = ?");
    vals.push(d.reg_address ? d.reg_address : null);
  }
  if (d.tax_branch_code !== undefined) {
    sets.push("tax_branch_code = ?");
    vals.push(d.tax_branch_code ? d.tax_branch_code : null);
  }
  if (sets.length === 0) return NextResponse.json({ error: "no_fields" }, { status: 400 });

  vals.push(d.branch_id);
  db.prepare(`UPDATE branches SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  logPersonaAction(user.id, "branch.update_tenant", d.branch_id);
  return NextResponse.json({ ok: true });
}
