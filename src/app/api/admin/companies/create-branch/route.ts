import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// POST /api/admin/companies/create-branch — super_admin adds a new
// branch under a company. The branch row only needs slug + name +
// company_id; every other column has a sensible schema default. The
// slug is auto-generated (URL-safe, unique) since the owner thinks
// in branch names, not slugs.

const Body = z.object({
  company_id: z.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  reg_address: z.string().trim().max(1000).nullable().optional(),
  tax_branch_code: z.string().trim().max(10).nullable().optional()
});

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Thai / non-latin names collapse to empty — fall back to a stable
  // prefix so the unique-suffix logic still produces a valid slug.
  return base || "branch";
}

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

  const company = db.prepare("SELECT id FROM companies WHERE id = ?").get(d.company_id);
  if (!company) return NextResponse.json({ error: "company_not_found" }, { status: 404 });

  // Ensure the slug is unique: try the base, then -2, -3, … and a
  // random tail as a last resort so we never loop forever.
  const exists = db.prepare("SELECT 1 FROM branches WHERE slug = ?");
  const baseSlug = slugify(d.name);
  let slug = baseSlug;
  let n = 1;
  while (exists.get(slug)) {
    n += 1;
    slug = `${baseSlug}-${n}`;
    if (n > 50) { slug = `${baseSlug}-${Date.now().toString(36)}`; break; }
  }

  const r = db.prepare(
    `INSERT INTO branches (slug, name, company_id, reg_address, tax_branch_code)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    slug,
    d.name,
    d.company_id,
    d.reg_address ? d.reg_address : null,
    d.tax_branch_code ? d.tax_branch_code : null
  );
  const id = Number(r.lastInsertRowid);
  logPersonaAction(user.id, "branch.create", id);
  return NextResponse.json({ ok: true, id });
}
