import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { unitCostFrom } from "@/lib/inventa";

// PATCH  /api/inventa/items/[id] — edit an item
// DELETE /api/inventa/items/[id] — soft-delete (active = 0); the row is
//   kept so historical count/order lines still resolve.

const Body = z.object({
  item_code: z.string().max(60).nullable().optional(),
  barcode: z.string().max(60).nullable().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  generic_name: z.string().max(200).nullable().optional(),
  cgd_code: z.string().max(60).nullable().optional(),
  category: z.string().max(120).nullable().optional(),
  storage_location: z.string().max(120).nullable().optional(),
  item_type: z.enum(["drug", "equipment"]).optional(),
  item_type_label: z.string().max(120).nullable().optional(),
  unit: z.string().max(40).nullable().optional(),
  last_purchase_price: z.number().min(0).nullable().optional(),
  last_purchase_units: z.number().min(0).nullable().optional(),
  unit_cost: z.number().min(0).nullable().optional(),
  cost_price: z.number().min(0).nullable().optional(),
  price_opd: z.number().min(0).nullable().optional(),
  price_ipd: z.number().min(0).nullable().optional(),
  price_uc: z.number().min(0).nullable().optional(),
  supplier_id: z.number().int().positive().nullable().optional(),
  grid_row: z.string().max(2).nullable().optional(),
  grid_col: z.number().int().min(1).max(6).nullable().optional(),
  pick_freq: z.enum(["R", "Y", "G"]).nullable().optional(),
  safety_stock: z.number().int().min(0).optional(),
  current_qty: z.number().int().min(0).optional()
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
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const d = parsed.data;

  const db = getDb();
  const row = db.prepare("SELECT id FROM inventa_items WHERE id = ?").get(id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const fields: string[] = [];
  const vals: Array<string | number | null> = [];
  const set = (col: string, v: string | number | null | undefined) => {
    if (v !== undefined) { fields.push(`${col} = ?`); vals.push(v ?? null); }
  };
  set("item_code", d.item_code);
  set("barcode", d.barcode);
  if (d.name !== undefined) set("name", d.name.trim());
  set("generic_name", d.generic_name);
  set("cgd_code", d.cgd_code);
  set("category", d.category);
  set("storage_location", d.storage_location);
  set("item_type", d.item_type);
  set("item_type_label", d.item_type_label);
  set("unit", d.unit);
  set("cost_price", d.cost_price);
  set("price_opd", d.price_opd);
  set("price_ipd", d.price_ipd);
  set("price_uc", d.price_uc);
  set("supplier_id", d.supplier_id);
  set("grid_row", d.grid_row);
  set("grid_col", d.grid_col);
  set("pick_freq", d.pick_freq);
  set("safety_stock", d.safety_stock);
  set("current_qty", d.current_qty);
  // Recompute unit_cost from the purchase line when either part is
  // supplied; else honour a directly-typed unit_cost.
  if ("last_purchase_price" in d || "last_purchase_units" in d) {
    set("last_purchase_price", d.last_purchase_price);
    set("last_purchase_units", d.last_purchase_units);
    fields.push("unit_cost = ?");
    vals.push(unitCostFrom(d.last_purchase_price, d.last_purchase_units));
  } else if (d.unit_cost !== undefined) {
    set("unit_cost", d.unit_cost);
  }

  if (fields.length === 0) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }
  fields.push("updated_at = CURRENT_TIMESTAMP");
  vals.push(id);
  db.prepare(`UPDATE inventa_items SET ${fields.join(", ")} WHERE id = ?`)
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
  const row = db.prepare("SELECT id FROM inventa_items WHERE id = ?").get(id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  db.prepare("UPDATE inventa_items SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(id);
  return NextResponse.json({ ok: true });
}
