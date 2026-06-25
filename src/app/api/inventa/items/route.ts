import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { unitCostFrom, type InventaItem } from "@/lib/inventa";

// GET  /api/inventa/items                — list active items (branch)
// GET  /api/inventa/items?barcode=xxx    — scan lookup (returns the one
//        matching item or null) used by the "scan to add/edit" flow
// POST /api/inventa/items                — create an item
//
// Any logged-in user may manage stock — clinic staff own the catalogue
// (admins are employees too). Branch-scoped via session activeBranchId.

const Body = z.object({
  item_code: z.string().max(60).nullable().optional(),
  barcode: z.string().max(60).nullable().optional(),
  name: z.string().trim().min(1).max(200),
  generic_name: z.string().max(200).nullable().optional(),
  cgd_code: z.string().max(60).nullable().optional(),
  category: z.string().max(120).nullable().optional(),
  storage_location: z.string().max(120).nullable().optional(),
  item_type: z.enum(["drug", "equipment"]).default("drug"),
  // Configurable ประเภทสินค้า (lookup-driven, free-form). The legacy
  // item_type enum stays for back-compat; this is the user-facing value.
  item_type_label: z.string().max(120).nullable().optional(),
  unit: z.string().max(40).nullable().optional(),
  // Cost is entered as a purchase line (price ÷ total smallest units);
  // the server derives unit_cost so packs/strips are normalised.
  last_purchase_price: z.number().min(0).nullable().optional(),
  last_purchase_units: z.number().min(0).nullable().optional(),
  unit_cost: z.number().min(0).nullable().optional(),
  // 2026-05: ราคาทุน entered manually. Kept distinct from unit_cost
  // (legacy moving avg from purchase lines) so the owner can pin a
  // budget price independent of receipts. PO totals read this first.
  cost_price: z.number().min(0).nullable().optional(),
  price_opd: z.number().min(0).nullable().optional(),
  price_ipd: z.number().min(0).nullable().optional(),
  price_uc: z.number().min(0).nullable().optional(),
  supplier_id: z.number().int().positive().nullable().optional(),
  grid_row: z.string().max(2).nullable().optional(),
  grid_col: z.number().int().min(1).max(6).nullable().optional(),
  pick_freq: z.enum(["R", "Y", "G"]).nullable().optional(),
  safety_stock: z.number().int().min(0).default(50),
  current_qty: z.number().int().min(0).default(0),
  // N5 pack: optional larger packaging unit + units-per-pack. Pure
  // data-entry convenience; base quantities stay in the smallest unit.
  pack_unit: z.string().max(40).nullable().optional(),
  pack_size: z.number().min(0).nullable().optional(),
  // Fractional-count mode (owner 2026-06-16) — liquids counted as
  // "bottles + % of the open bottle". qty_frac = initial on-hand in bottles
  // (decimal). For fractional items safety_stock is read as "% of a bottle".
  count_mode: z.enum(["discrete", "fractional"]).default("discrete"),
  qty_frac: z.number().min(0).nullable().optional()
});

export async function GET(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const branchId = user.activeBranchId ?? null;
  const db = getDb();

  const url = new URL(req.url);
  // A scan resolves either the box barcode OR the item_code (the QR we
  // print encodes item_code). `code` is the new param; `barcode` kept
  // for back-compat.
  const code = (url.searchParams.get("code") ?? url.searchParams.get("barcode"))?.trim();
  if (code) {
    const item = db.prepare(`
      SELECT * FROM inventa_items
      WHERE (barcode = ? OR item_code = ?) AND active = 1
        AND (branch_id IS ? OR branch_id = ?)
      ORDER BY id DESC LIMIT 1
    `).get(code, code, branchId, branchId) as InventaItem | undefined;
    return NextResponse.json({ ok: true, item: item ?? null });
  }

  const items = db.prepare(`
    SELECT i.*, s.name AS supplier_name
    FROM inventa_items i
    LEFT JOIN inventa_suppliers s ON s.id = i.supplier_id
    WHERE i.active = 1 AND (i.branch_id IS ? OR i.branch_id = ?)
    ORDER BY i.grid_row, i.grid_col, i.name
  `).all(branchId, branchId);
  return NextResponse.json({ ok: true, items });
}

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const d = parsed.data;
  // Money typed by the owner is a clean 2-dp value — round to kill FP noise
  // (owner 2026-06-25: typed 50 saved as 49.9999). The derived purchase-line
  // cost keeps its 4-dp precision (sub-cent per-unit from large packs).
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const unitCost = d.last_purchase_price != null && d.last_purchase_units
    ? unitCostFrom(d.last_purchase_price, d.last_purchase_units)
    : r2(d.unit_cost ?? 0);
  const costPrice = d.cost_price != null ? r2(d.cost_price) : null;

  // Fractional items: safety_stock is a "% of a bottle" (clamp 0-100), the
  // on-hand lives in qty_frac (bottles, decimal) and current_qty stays 0.
  const isFractional = d.count_mode === "fractional";
  const safetyStock = isFractional ? Math.min(100, Math.max(0, d.safety_stock)) : d.safety_stock;
  const currentQty = isFractional ? 0 : d.current_qty;
  const qtyFrac = isFractional ? (d.qty_frac ?? 0) : null;

  const db = getDb();
  const info = db.prepare(`
    INSERT INTO inventa_items
      (branch_id, item_code, barcode, name, generic_name, cgd_code,
       category, storage_location, item_type, item_type_label, unit, unit_cost, cost_price,
       last_purchase_price, last_purchase_units, price_opd, price_ipd,
       price_uc, supplier_id, grid_row, grid_col, pick_freq,
       safety_stock, current_qty, pack_unit, pack_size,
       count_mode, qty_frac, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    user.activeBranchId ?? null,
    d.item_code ?? null, d.barcode ?? null, d.name.trim(),
    d.generic_name ?? null, d.cgd_code ?? null, d.category ?? null,
    d.storage_location ?? null, d.item_type, d.item_type_label ?? null, d.unit ?? null, unitCost,
    costPrice,
    d.last_purchase_price ?? null, d.last_purchase_units ?? null,
    d.price_opd ?? null, d.price_ipd ?? null, d.price_uc ?? null,
    d.supplier_id ?? null, d.grid_row ?? null, d.grid_col ?? null,
    d.pick_freq ?? null, safetyStock, currentQty,
    d.pack_unit ?? null, (d.pack_size != null && d.pack_size > 1 ? d.pack_size : null),
    d.count_mode, qtyFrac,
    user.id
  );
  return NextResponse.json({ ok: true, id: Number(info.lastInsertRowid) });
}
