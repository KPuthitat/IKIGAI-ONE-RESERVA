import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperAdmin } from "@/lib/auth";
import { createRbacRole, logPersonaAction } from "@/lib/db";
import { sanitizePermissionKeys } from "@/lib/rbac";

// POST /api/admin/roles — create a custom role (super_admin only).
// Permission management is super_admin-only (rbac.manage); requireSuperAdmin
// redirects non-super_admins, so reaching here means authorised.
const Body = z.object({
  name: z.string().min(1).max(60),
  description: z.string().max(200).nullable().optional(),
  permissions: z.array(z.string()).max(50).default([])
});

export async function POST(req: Request) {
  const actor = requireSuperAdmin();
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { name, description } = parsed.data;
  const permissions = sanitizePermissionKeys(parsed.data.permissions);
  const id = createRbacRole(name, description ?? null, permissions);
  logPersonaAction(actor.id, "rbac.role.create", id);
  return NextResponse.json({ ok: true, id });
}
