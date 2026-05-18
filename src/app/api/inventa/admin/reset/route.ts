import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// POST /api/inventa/admin/reset — super_admin "factory reset" of all
// INVENTA data, every branch + global. Wipes items, suppliers,
// lookups (including the global seed rows), counts and orders so the
// module can be set up cleanly from scratch.
//
// Destructive + irreversible — gated behind super_admin AND a typed
// confirmation phrase echoed from the UI.

const Body = z.object({ confirm: z.literal("ล้างข้อมูล") });

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden_super_admin_only" }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "confirm_mismatch" }, { status: 400 });
  }
  const db = getDb();
  const deleted = { items: 0, suppliers: 0, lookups: 0, counts: 0, orders: 0 };
  const txn = db.transaction(() => {
    // Child rows first (FKs ON DELETE CASCADE handle most, but be
    // explicit so the operation is order-independent + auditable).
    db.prepare("DELETE FROM inventa_order_lines").run();
    deleted.orders = db.prepare("DELETE FROM inventa_orders").run().changes;
    db.prepare("DELETE FROM inventa_count_lines").run();
    deleted.counts = db.prepare("DELETE FROM inventa_counts").run().changes;
    deleted.items = db.prepare("DELETE FROM inventa_items").run().changes;
    deleted.suppliers = db.prepare("DELETE FROM inventa_suppliers").run().changes;
    deleted.lookups = db.prepare("DELETE FROM inventa_lookups").run().changes;
  });
  txn();

  logPersonaAction(user.id, "inventa.reset_all", 0);
  return NextResponse.json({ ok: true, deleted });
}
