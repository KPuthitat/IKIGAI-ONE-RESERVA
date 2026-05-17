import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// CRUD for companies. Companies are top-level tenants — only admins
// (any branch) can manage them today; later we'll wire up a super-
// admin flag and gate this. Soft-delete (active=0) keeps historical
// branch.company_id references intact.

const CreateBody = z.object({
  name_th: z.string().trim().min(1).max(200),
  name_en: z.string().trim().max(200).nullable().optional(),
  tax_id: z.string().trim().max(20).nullable().optional(),
  address: z.string().trim().max(1000).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().max(120).nullable().optional()
});
const UpdateBody = CreateBody.partial().extend({
  id: z.number().int().positive(),
  active: z.boolean().optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin") return NextResponse.json({ error: "forbidden_super_admin_only" }, { status: 403 });

  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;
  const r = getDb().prepare(`
    INSERT INTO companies (name_th, name_en, tax_id, address, phone, email, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(
    d.name_th.trim(),
    d.name_en?.trim() || null,
    d.tax_id?.trim() || null,
    d.address?.trim() || null,
    d.phone?.trim() || null,
    d.email?.trim() || null
  );
  const id = Number(r.lastInsertRowid);
  logPersonaAction(user.id, "company.create", id);
  return NextResponse.json({ ok: true, id });
}

export async function PATCH(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin") return NextResponse.json({ error: "forbidden_super_admin_only" }, { status: 403 });

  const parsed = UpdateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;
  const db = getDb();
  const sets: string[] = [];
  const vals: Array<string | number | null> = [];
  const map: Array<[keyof typeof d, string]> = [
    ["name_th",  "name_th"],  ["name_en", "name_en"],
    ["tax_id",   "tax_id"],   ["address", "address"],
    ["phone",    "phone"],    ["email",   "email"]
  ];
  for (const [k, col] of map) {
    if (d[k] !== undefined) {
      sets.push(`${col} = ?`);
      const v = d[k] as string | null | undefined;
      vals.push(v?.toString().trim() || null);
    }
  }
  if (d.active !== undefined) {
    sets.push("active = ?");
    vals.push(d.active ? 1 : 0);
  }
  if (sets.length === 0) return NextResponse.json({ error: "no_fields" }, { status: 400 });
  vals.push(d.id);
  db.prepare(`UPDATE companies SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  logPersonaAction(user.id, "company.update", d.id);
  return NextResponse.json({ ok: true });
}

const DeleteBody = z.object({ id: z.number().int().positive() });

export async function DELETE(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin") return NextResponse.json({ error: "forbidden_super_admin_only" }, { status: 403 });

  const parsed = DeleteBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const db = getDb();
  // Detach any branches first (company_id → NULL) so deleting the
  // company never leaves a dangling FK. An unassigned branch is a
  // valid state — the owner re-points it from /admin/companies.
  const detached = db.prepare(
    "SELECT COUNT(*) AS n FROM branches WHERE company_id = ?"
  ).get(parsed.data.id) as { n: number };
  const txn = db.transaction(() => {
    db.prepare("UPDATE branches SET company_id = NULL WHERE company_id = ?").run(parsed.data.id);
    db.prepare("DELETE FROM companies WHERE id = ?").run(parsed.data.id);
  });
  txn();
  logPersonaAction(user.id, "company.delete", parsed.data.id);
  return NextResponse.json({ ok: true, detached_branches: detached.n });
}
