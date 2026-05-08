import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getZoneById, upsertZone, deleteZone } from "@/lib/zones";

const PatchBody = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  description: z.string().max(200).nullable().optional(),
  display_order: z.number().int().min(1).max(9999).optional(),
  active: z.union([z.literal(0), z.literal(1)]).optional()
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const zone = getZoneById(id);
  if (!zone) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (zone.branch_id !== user.activeBranchId) {
    return NextResponse.json({ error: "wrong_branch" }, { status: 403 });
  }

  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;

  try {
    upsertZone({
      id,
      branch_id: zone.branch_id,
      name: d.name ?? zone.name,
      description: d.description !== undefined ? d.description : zone.description,
      display_order: d.display_order ?? zone.display_order,
      active: (d.active ?? zone.active) as 0 | 1
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("UNIQUE")) {
      return NextResponse.json({ error: "duplicate_name" }, { status: 409 });
    }
    return NextResponse.json({ error: "save_failed", detail: msg }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const zone = getZoneById(id);
  if (!zone) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (zone.branch_id !== user.activeBranchId) {
    return NextResponse.json({ error: "wrong_branch" }, { status: 403 });
  }

  // Hard-delete is fine: the foreign-key on tables.zone_id is ON DELETE
  // SET NULL, so any tables in this zone keep existing but appear in the
  // "ไม่ระบุโซน" bucket until reassigned.
  deleteZone(id);
  return NextResponse.json({ ok: true });
}
