import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// POST /api/inventa/suppliers/[id]/reorder  { direction: "up" | "down" }
//
// Swap display_order with the immediate neighbour (same branch). See
// the matching lookups/[id]/reorder route for the rationale — same
// strategy, scoped to inventa_suppliers.

const Body = z.object({ direction: z.enum(["up", "down"]) });

export async function POST(req: Request, { params }: { params: { id: string } }) {
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
  const { direction } = parsed.data;
  const db = getDb();

  const me = db.prepare(
    "SELECT id, branch_id, display_order FROM inventa_suppliers WHERE id = ? AND active = 1"
  ).get(id) as { id: number; branch_id: number | null; display_order: number } | undefined;
  if (!me) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const neighbour = (direction === "up"
    ? db.prepare(`
        SELECT id, display_order FROM inventa_suppliers
        WHERE active = 1
          AND ((@branchId IS NULL AND branch_id IS NULL) OR branch_id = @branchId)
          AND id != @id
          AND display_order <= @ord
        ORDER BY display_order DESC, id DESC
        LIMIT 1
      `)
    : db.prepare(`
        SELECT id, display_order FROM inventa_suppliers
        WHERE active = 1
          AND ((@branchId IS NULL AND branch_id IS NULL) OR branch_id = @branchId)
          AND id != @id
          AND display_order >= @ord
        ORDER BY display_order ASC, id ASC
        LIMIT 1
      `)
  ).get({
    branchId: me.branch_id, id: me.id, ord: me.display_order
  }) as { id: number; display_order: number } | undefined;

  if (!neighbour) {
    return NextResponse.json({ ok: true, moved: false });
  }

  const tx = db.transaction(() => {
    if (neighbour.display_order === me.display_order) {
      const bumped = direction === "up" ? me.display_order - 1 : me.display_order + 1;
      db.prepare("UPDATE inventa_suppliers SET display_order = ? WHERE id = ?")
        .run(bumped, me.id);
    } else {
      db.prepare("UPDATE inventa_suppliers SET display_order = ? WHERE id = ?")
        .run(neighbour.display_order, me.id);
      db.prepare("UPDATE inventa_suppliers SET display_order = ? WHERE id = ?")
        .run(me.display_order, neighbour.id);
    }
  });
  tx();

  return NextResponse.json({ ok: true, moved: true });
}
