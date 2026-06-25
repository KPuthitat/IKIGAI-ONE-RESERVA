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
  current_qty: z.number().int().min(0).optional(),
  pack_unit: z.string().max(40).nullable().optional(),
  pack_size: z.number().min(0).nullable().optional(),
  // Fractional-count mode toggle (owner 2026-06-16). qty_frac is changed via
  // count rounds, not this edit form (same as current_qty).
  count_mode: z.enum(["discrete", "fractional"]).optional(),
  // Reorder mute (owner 2026-06-16) — 1 = hide from the "should order" list
  // even when below safety (LASA substitute not currently in use).
  reorder_muted: z.number().int().min(0).max(1).optional()
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
  const row = db.prepare("SELECT id, count_mode FROM inventa_items WHERE id = ?")
    .get(id) as { id: number; count_mode: string | null } | undefined;
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Effective mode after this patch — drives the safety_stock interpretation.
  const effectiveMode = d.count_mode ?? row.count_mode ?? "discrete";

  const fields: string[] = [];
  const vals: Array<string | number | null> = [];
  const set = (col: string, v: string | number | null | undefined) => {
    if (v !== undefined) { fields.push(`${col} = ?`); vals.push(v ?? null); }
  };
  // Money fields the owner types are clean 2-dp values — round to kill any
  // floating-point noise (owner 2026-06-25: typed 50 was showing as 49.9999).
  const r2 = (n: number | null | undefined) => (n == null ? n : Math.round(n * 100) / 100);
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
  set("cost_price", r2(d.cost_price));
  set("price_opd", d.price_opd);
  set("price_ipd", d.price_ipd);
  set("price_uc", d.price_uc);
  set("supplier_id", d.supplier_id);
  set("grid_row", d.grid_row);
  set("grid_col", d.grid_col);
  set("pick_freq", d.pick_freq);
  set("count_mode", d.count_mode);
  // Fractional items read safety_stock as "% of a bottle" → clamp 0-100.
  if (d.safety_stock !== undefined) {
    set("safety_stock", effectiveMode === "fractional"
      ? Math.min(100, Math.max(0, d.safety_stock))
      : d.safety_stock);
  }
  set("current_qty", d.current_qty);
  set("reorder_muted", d.reorder_muted);
  set("pack_unit", d.pack_unit);
  // Normalise pack_size: anything ≤ 1 means "no pack" → store NULL.
  if (d.pack_size !== undefined) {
    set("pack_size", d.pack_size != null && d.pack_size > 1 ? d.pack_size : null);
  }
  // Recompute unit_cost from the purchase line when either part is
  // supplied; else honour a directly-typed unit_cost.
  if ("last_purchase_price" in d || "last_purchase_units" in d) {
    set("last_purchase_price", d.last_purchase_price);
    set("last_purchase_units", d.last_purchase_units);
    fields.push("unit_cost = ?");
    vals.push(unitCostFrom(d.last_purchase_price, d.last_purchase_units));
  } else if (d.unit_cost !== undefined) {
    // Directly-typed selling price → clean 2-dp money (not the 4-dp derived cost).
    set("unit_cost", r2(d.unit_cost));
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
