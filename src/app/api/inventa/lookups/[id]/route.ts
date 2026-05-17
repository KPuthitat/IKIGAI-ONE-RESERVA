import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// PATCH  /api/inventa/lookups/[id] — rename / reorder an option
// DELETE /api/inventa/lookups/[id] — soft-delete (active = 0). Items
//   that already stored the text value keep it (the value is denorm-
//   alised onto inventa_items), so removing an option is safe.
//
// Note: global seed rows (branch_id NULL) can also be hidden this way.

const Body = z.object({
  value: z.string().trim().min(1).max(200).optional(),
  sort_order: z.number().int().optional()
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const d = parsed.data;
  const db = getDb();
  const row = db.prepare("SELECT id FROM inventa_lookups WHERE id = ?").get(id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const fields: string[] = [];
  const vals: Array<string | number> = [];
  if (d.value !== undefined) { fields.push("value = ?"); vals.push(d.value.trim()); }
  if (d.sort_order !== undefined) { fields.push("sort_order = ?"); vals.push(d.sort_order); }
  if (fields.length === 0) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }
  vals.push(id);
  db.prepare(`UPDATE inventa_lookups SET ${fields.join(", ")} WHERE id = ?`)
    .run(...vals);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  const row = db.prepare("SELECT id FROM inventa_lookups WHERE id = ?").get(id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  db.prepare("UPDATE inventa_lookups SET active = 0 WHERE id = ?").run(id);
  return NextResponse.json({ ok: true });
}
