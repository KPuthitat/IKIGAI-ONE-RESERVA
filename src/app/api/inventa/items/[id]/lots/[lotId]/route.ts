import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// PATCH  /api/inventa/items/[id]/lots/[lotId] — edit lot fields
// DELETE /api/inventa/items/[id]/lots/[lotId] — hard delete (lots
//   are an auxiliary register; removing one doesn't affect current_qty).

const Body = z.object({
  lot_number: z.string().trim().max(80).nullable().optional(),
  expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  qty: z.number().int().min(0).optional(),
  note: z.string().trim().max(500).nullable().optional()
});

export async function PATCH(
  req: Request,
  { params }: { params: { id: string; lotId: string } }
) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const itemId = Number(params.id);
  const lotId = Number(params.lotId);
  if (!Number.isInteger(itemId) || itemId <= 0 ||
      !Number.isInteger(lotId) || lotId <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const d = parsed.data;
  const db = getDb();
  const row = db.prepare(
    "SELECT id FROM inventa_item_lots WHERE id = ? AND item_id = ?"
  ).get(lotId, itemId);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const fields: string[] = [];
  const vals: Array<string | number | null> = [];
  const set = (c: string, v: string | number | null | undefined) => {
    if (v !== undefined) { fields.push(`${c} = ?`); vals.push(v ?? null); }
  };
  if (d.lot_number !== undefined) set("lot_number", d.lot_number?.trim() || null);
  set("expiry_date", d.expiry_date);
  set("qty", d.qty);
  if (d.note !== undefined) set("note", d.note?.trim() || null);
  if (fields.length === 0) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }
  vals.push(lotId);
  db.prepare(`UPDATE inventa_item_lots SET ${fields.join(", ")} WHERE id = ?`)
    .run(...vals);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string; lotId: string } }
) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const itemId = Number(params.id);
  const lotId = Number(params.lotId);
  if (!Number.isInteger(itemId) || itemId <= 0 ||
      !Number.isInteger(lotId) || lotId <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  const row = db.prepare(
    "SELECT id FROM inventa_item_lots WHERE id = ? AND item_id = ?"
  ).get(lotId, itemId);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  db.prepare("DELETE FROM inventa_item_lots WHERE id = ?").run(lotId);
  return NextResponse.json({ ok: true });
}
