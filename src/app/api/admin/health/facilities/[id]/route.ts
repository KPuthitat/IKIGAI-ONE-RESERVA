import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperAdmin } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { updateHealthFacility, deleteHealthFacility } from "@/lib/health-facility";

// PATCH  /api/admin/health/facilities/[id] — edit a facility
// DELETE /api/admin/health/facilities/[id] — remove (never the last one)

const Body = z.object({
  name: z.string().min(2).max(200),
  license_no: z.string().max(100).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  logo_path: z.string().max(300).nullable().optional(),
  make_default: z.boolean().optional()
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const actor = requireSuperAdmin();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const ok = updateHealthFacility(id, {
    name: parsed.data.name,
    license_no: parsed.data.license_no ?? null,
    address: parsed.data.address ?? null,
    logo_path: parsed.data.logo_path ?? null,
    makeDefault: !!parsed.data.make_default
  });
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  logPersonaAction(actor.id, "health.facility.update", id);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const actor = requireSuperAdmin();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }
  const res = deleteHealthFacility(id);
  if (!res.ok) {
    return NextResponse.json({ error: res.reason ?? "failed" }, { status: 400 });
  }
  logPersonaAction(actor.id, "health.facility.delete", id);
  return NextResponse.json({ ok: true });
}
