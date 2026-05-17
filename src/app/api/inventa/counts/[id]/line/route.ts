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
  counted_qty: z.number().int().min(0)
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
    "SELECT id, current_qty FROM inventa_items WHERE id = ? AND active = 1"
  ).get(item_id) as { id: number; current_qty: number } | undefined;
  if (!item) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

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
      `).run(countId, item_id, item.current_qty, counted_qty);
    }
    db.prepare(
      "UPDATE inventa_items SET current_qty = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(counted_qty, item_id);
  });
  tx();

  return NextResponse.json({ ok: true });
}
