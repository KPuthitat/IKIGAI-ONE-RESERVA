import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// POST /api/inventa/counts/[id]/line — record a counted line in an
// open weekly-count session. Captures prev_qty once (the on-hand
// before this count), upserts counted_qty, and writes the counted
// value straight back to inventa_items.current_qty so the catalogue
// and low-stock flags stay live during the count.

const Body = z.object({
  item_id: z.number().int().positive(),
  // Decimal allowed for fractional (bottle) items, e.g. 3.2 bottles. Discrete
  // items are still required to be whole — enforced per-item below.
  counted_qty: z.number().min(0)
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const countId = Number(params.id);
  if (!Number.isInteger(countId) || countId <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { item_id, counted_qty } = parsed.data;

  const db = getDb();
  const count = db.prepare(
    "SELECT id, status FROM inventa_counts WHERE id = ?"
  ).get(countId) as { id: number; status: string } | undefined;
  if (!count) return NextResponse.json({ error: "count_not_found" }, { status: 404 });
  if (count.status !== "open") {
    return NextResponse.json({ error: "count_closed" }, { status: 409 });
  }
  const item = db.prepare(
    "SELECT id, current_qty, count_mode, qty_frac FROM inventa_items WHERE id = ? AND active = 1"
  ).get(item_id) as
    | { id: number; current_qty: number; count_mode: string | null; qty_frac: number | null }
    | undefined;
  if (!item) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  const fractional = item.count_mode === "fractional";
  // Discrete items must be whole units; fractional (bottle) items accept a
  // decimal (e.g. 3.2 bottles = 3 full + open one at 20%).
  if (!fractional && !Number.isInteger(counted_qty)) {
    return NextResponse.json({ error: "must_be_integer" }, { status: 400 });
  }
  // prev = the on-hand before this count, in the item's own unit.
  const prevQty = fractional ? (item.qty_frac ?? 0) : item.current_qty;

  const tx = db.transaction(() => {
    const existing = db.prepare(
      "SELECT id, prev_qty FROM inventa_count_lines WHERE count_id = ? AND item_id = ?"
    ).get(countId, item_id) as { id: number; prev_qty: number | null } | undefined;

    if (existing) {
      db.prepare("UPDATE inventa_count_lines SET counted_qty = ? WHERE id = ?")
        .run(counted_qty, existing.id);
    } else {
      db.prepare(`
        INSERT INTO inventa_count_lines (count_id, item_id, prev_qty, counted_qty)
        VALUES (?, ?, ?, ?)
      `).run(countId, item_id, prevQty, counted_qty);
    }
    // Write back to the item's live on-hand — qty_frac for fractional, the
    // integer current_qty for discrete.
    if (fractional) {
      db.prepare(
        "UPDATE inventa_items SET qty_frac = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(counted_qty, item_id);
    } else {
      db.prepare(
        "UPDATE inventa_items SET current_qty = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(counted_qty, item_id);
    }
  });
  tx();

  return NextResponse.json({ ok: true });
}
