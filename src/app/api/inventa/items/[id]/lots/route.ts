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
  const item = db.prepare("SELECT id FROM inventa_items WHERE id = ? AND active = 1")
    .get(id) as { id: number } | undefined;
  if (!item) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const info = db.prepare(`
    INSERT INTO inventa_item_lots
      (item_id, lot_number, expiry_date, qty, note, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    d.lot_number?.trim() || null,
    d.expiry_date ?? null,
    d.qty,
    d.note?.trim() || null,
    user.id
  );
  return NextResponse.json({ ok: true, id: Number(info.lastInsertRowid) });
}
