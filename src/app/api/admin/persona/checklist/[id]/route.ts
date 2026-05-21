import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, type ShiftChecklistItem } from "@/lib/db";

const PatchBody = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  display_order: z.number().int().min(0).max(100_000).optional(),
  active: z.union([z.literal(0), z.literal(1)]).optional(),
  kind: z.enum(["checkbox", "text"]).optional()
});

/** Look up the item and verify the calling admin is assigned to the
 *  item's branch. Prevents an admin of branch A from editing branch B's
 *  checklist by guessing item ids. */
function loadGuarded(id: number, user: NonNullable<ReturnType<typeof getSessionUser>>) {
  const item = getDb().prepare(
    "SELECT * FROM shift_checklist_items WHERE id = ?"
  ).get(id) as ShiftChecklistItem | undefined;
  if (!item) return { ok: false as const, status: 404, error: "not_found" };
  if (!userHasBranch(user, item.branch_id)) {
    return { ok: false as const, status: 403, error: "branch_forbidden" };
  }
  return { ok: true as const, item };
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user || user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const guard = loadGuarded(id, user);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const updates: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v !== undefined) updates[k] = v;
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: true });
  }
  const sets = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
  getDb().prepare(`UPDATE shift_checklist_items SET ${sets} WHERE id = ?`)
    .run(...Object.values(updates), id);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user || user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const guard = loadGuarded(id, user);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  // Hard delete — historical reports stored the label string already so
  // they keep their data even after the item row is gone. If admin wants
  // to "hide but keep data", they can soft-delete via PATCH active=0.
  getDb().prepare("DELETE FROM shift_checklist_items WHERE id = ?").run(id);
  return NextResponse.json({ ok: true });
}
