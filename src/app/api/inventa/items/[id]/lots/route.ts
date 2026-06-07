import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import type { InventaItemLot } from "@/lib/inventa";

// GET  /api/inventa/items/[id]/lots
//   List active lots for one item, newest-first inside each expiry
//   bucket so the soonest-to-expire lot sits at the top of the list.
//
// POST /api/inventa/items/[id]/lots  { lot_number?, expiry_date?, qty, note? }
//   Add a new lot. qty is the smallest-unit count received in this
//   batch. Does NOT touch inventa_items.current_qty — staff still
//   own the totals via the existing count flow; lots are purely a
//   per-batch expiry register.
//
// Item-level scope: a delete endpoint lives at lots/[lotId]/route.ts
// next to this one for one-off removal.

const Body = z.object({
  lot_number: z.string().trim().max(80).nullable().optional(),
  expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  qty: z.number().int().min(0),
  // Cost paid per unit for this receipt (owner F6). When it differs from
  // the item's current cost price we re-price the item + log the change.
  unit_cost: z.number().min(0).max(10_000_000).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional()
});

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  // Order: expiry asc with NULL last (no-expiry lots sink), then
  // received_at desc so the most recently received batch tops a tie.
  const lots = db.prepare(`
    SELECT * FROM inventa_item_lots
    WHERE item_id = ?
    ORDER BY (expiry_date IS NULL) ASC, expiry_date ASC, received_at DESC
  `).all(id) as InventaItemLot[];
  return NextResponse.json({ ok: true, lots });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const d = parsed.data;
  const db = getDb();
  const item = db.prepare("SELECT id, cost_price FROM inventa_items WHERE id = ? AND active = 1")
    .get(id) as { id: number; cost_price: number | null } | undefined;
  if (!item) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Did this receipt change the item's cost price? (owner F6)
  //   • a value given AND (no cost yet → first-time set, OR differs) → re-price + log
  //   • same as current, or left blank → no change
  const newCost = d.unit_cost != null && d.unit_cost > 0 ? d.unit_cost : null;
  const costChanged = newCost != null && item.cost_price !== newCost;

  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO inventa_item_lots
        (item_id, lot_number, expiry_date, qty, unit_cost, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      d.lot_number?.trim() || null,
      d.expiry_date ?? null,
      d.qty,
      newCost,
      d.note?.trim() || null,
      user.id
    );
    const lotId = Number(info.lastInsertRowid);
    if (costChanged) {
      db.prepare("UPDATE inventa_items SET cost_price = ? WHERE id = ?").run(newCost, id);
      db.prepare(`
        INSERT INTO inventa_cost_changes
          (item_id, old_cost, new_cost, source, lot_id, changed_by)
        VALUES (?, ?, ?, 'receive', ?, ?)
      `).run(id, item.cost_price, newCost, lotId, user.id);
    }
    return lotId;
  });
  const lotId = tx();
  return NextResponse.json({ ok: true, id: lotId, costChanged });
}
