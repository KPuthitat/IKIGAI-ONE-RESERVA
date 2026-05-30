import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// POST /api/inventa/lookups/[id]/reorder  { direction: "up" | "down" }
//
// Swaps sort_order with the immediate neighbour (same kind + branch).
// Concurrency is a non-issue here (one super_admin in the settings
// tab at a time), so a 2-row swap is plenty. Step gaps of 10 in the
// new-row path leave headroom; if rows happen to share a sort_order,
// we bump by 1 on swap to break the tie deterministically.

const Body = z.object({ direction: z.enum(["up", "down"]) });

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin") {
    return NextResponse.json({ error: "super_admin_only" }, { status: 403 });
  }
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
    "SELECT id, kind, branch_id, sort_order FROM inventa_lookups WHERE id = ? AND active = 1"
  ).get(id) as { id: number; kind: string; branch_id: number | null; sort_order: number } | undefined;
  if (!me) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Neighbour query: same branch + kind, strictly above (smaller
  // sort_order) for "up" or strictly below for "down". We allow equal
  // sort_order only when the id differs so a tied row still acts as
  // a swap target — the tie is broken by the +/- 1 bump in the
  // transaction below.
  const neighbour = (direction === "up"
    ? db.prepare(`
        SELECT id, sort_order FROM inventa_lookups
        WHERE active = 1 AND kind = @kind
          AND ((@branchId IS NULL AND branch_id IS NULL) OR branch_id = @branchId)
          AND id != @id
          AND sort_order <= @sortOrder
        ORDER BY sort_order DESC, id DESC
        LIMIT 1
      `)
    : db.prepare(`
        SELECT id, sort_order FROM inventa_lookups
        WHERE active = 1 AND kind = @kind
          AND ((@branchId IS NULL AND branch_id IS NULL) OR branch_id = @branchId)
          AND id != @id
          AND sort_order >= @sortOrder
        ORDER BY sort_order ASC, id ASC
        LIMIT 1
      `)
  ).get({
    kind: me.kind, branchId: me.branch_id, id: me.id, sortOrder: me.sort_order
  }) as { id: number; sort_order: number } | undefined;

  if (!neighbour) {
    return NextResponse.json({ ok: true, moved: false });
  }

  const tx = db.transaction(() => {
    if (neighbour.sort_order === me.sort_order) {
      const bumped = direction === "up" ? me.sort_order - 1 : me.sort_order + 1;
      db.prepare("UPDATE inventa_lookups SET sort_order = ? WHERE id = ?")
        .run(bumped, me.id);
    } else {
      db.prepare("UPDATE inventa_lookups SET sort_order = ? WHERE id = ?")
        .run(neighbour.sort_order, me.id);
      db.prepare("UPDATE inventa_lookups SET sort_order = ? WHERE id = ?")
        .run(me.sort_order, neighbour.id);
    }
  });
  tx();

  return NextResponse.json({ ok: true, moved: true });
}
