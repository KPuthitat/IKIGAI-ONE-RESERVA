import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperAdmin } from "@/lib/auth";
import { updateRbacRole, deleteRbacRole, logPersonaAction } from "@/lib/db";
import { sanitizePermissionKeys } from "@/lib/rbac";

// PATCH /api/admin/roles/[id] — rename + reset permissions (super_admin).
// System roles can be edited (name/permissions) but never deleted.
const Body = z.object({
  name: z.string().min(1).max(60),
  description: z.string().max(200).nullable().optional(),
  permissions: z.array(z.string()).max(50).default([])
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const actor = requireSuperAdmin();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { name, description } = parsed.data;
  const permissions = sanitizePermissionKeys(parsed.data.permissions);
  updateRbacRole(id, name, description ?? null, permissions);
  logPersonaAction(actor.id, "rbac.role.update", id);
  return NextResponse.json({ ok: true });
}

// DELETE /api/admin/roles/[id] — remove a custom role (+ its assignments).
// System roles are protected (returns 400 system_role).
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const actor = requireSuperAdmin();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const res = deleteRbacRole(id);
  if (!res.ok) {
    const status = res.reason === "not_found" ? 404 : 400;
    return NextResponse.json({ error: res.reason }, { status });
  }
  logPersonaAction(actor.id, "rbac.role.delete", id);
  return NextResponse.json({ ok: true });
}
