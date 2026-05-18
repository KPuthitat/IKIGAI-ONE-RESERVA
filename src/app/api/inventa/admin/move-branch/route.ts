import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// POST /api/inventa/admin/move-branch — super_admin tool to move ALL
// INVENTA data of one branch to another branch.
//
// Use case: the catalogue/suppliers/counts/orders were built/tested
// under one branch (e.g. NAMA) but should belong to another (e.g.
// AT HOME CLINIC). The source branch ends up with no INVENTA data so
// it can be set up fresh.
//
// What moves (branch_id reassigned):
//   inventa_items, inventa_suppliers, inventa_counts, inventa_orders,
//   and BRANCH-SPECIFIC inventa_lookups (rows whose branch_id = from).
// Global lookups (branch_id IS NULL) are shared — left untouched.
// count_lines / order_lines carry no branch_id; they follow their
// parent automatically.
//
// Idempotent: running again with the same (from → to) is a no-op
// because the source branch no longer has rows.

const Body = z.object({
  from_branch_id: z.number().int().positive(),
  to_branch_id: z.number().int().positive()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden_super_admin_only" }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { from_branch_id, to_branch_id } = parsed.data;
  if (from_branch_id === to_branch_id) {
    return NextResponse.json({ error: "same_branch" }, { status: 400 });
  }
  const db = getDb();
  const exists = db.prepare("SELECT id FROM branches WHERE id = ?");
  if (!exists.get(from_branch_id) || !exists.get(to_branch_id)) {
    return NextResponse.json({ error: "branch_not_found" }, { status: 404 });
  }

  const moved = { items: 0, suppliers: 0, lookups: 0, counts: 0, orders: 0 };
  const txn = db.transaction(() => {
    moved.items = db.prepare(
      "UPDATE inventa_items SET branch_id = ? WHERE branch_id = ?"
    ).run(to_branch_id, from_branch_id).changes;
    moved.suppliers = db.prepare(
      "UPDATE inventa_suppliers SET branch_id = ? WHERE branch_id = ?"
    ).run(to_branch_id, from_branch_id).changes;
    // Branch-specific lookups only — never touch global (NULL) rows.
    moved.lookups = db.prepare(
      "UPDATE inventa_lookups SET branch_id = ? WHERE branch_id = ?"
    ).run(to_branch_id, from_branch_id).changes;
    moved.counts = db.prepare(
      "UPDATE inventa_counts SET branch_id = ? WHERE branch_id = ?"
    ).run(to_branch_id, from_branch_id).changes;
    moved.orders = db.prepare(
      "UPDATE inventa_orders SET branch_id = ? WHERE branch_id = ?"
    ).run(to_branch_id, from_branch_id).changes;
  });
  txn();

  logPersonaAction(user.id, "inventa.move_branch", to_branch_id);
  return NextResponse.json({ ok: true, from_branch_id, to_branch_id, moved });
}
