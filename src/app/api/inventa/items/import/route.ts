import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// POST /api/inventa/items/import — bulk-create items from a parsed CSV
// (the client parses the file and sends an array of row objects). Each
// row is inserted independently; bad rows are skipped and reported so
// one typo doesn't abort the whole lot. Supplier is matched by exact
// name (active, this branch or global); unmatched → left blank.

const Row = z.object({
  name: z.string().trim().min(1).max(200),
  generic_name: z.string().max(200).optional(),
  item_code: z.string().max(60).optional(),
  barcode: z.string().max(60).optional(),
  category: z.string().max(120).optional(),
  item_type: z.string().max(20).optional(),
  unit: z.string().max(40).optional(),
  unit_cost: z.union([z.number(), z.string()]).optional(),
  storage_location: z.string().max(120).optional(),
  grid_row: z.string().max(2).optional(),
  grid_col: z.union([z.number(), z.string()]).optional(),
  pick_freq: z.string().max(1).optional(),
  safety_stock: z.union([z.number(), z.string()]).optional(),
  current_qty: z.union([z.number(), z.string()]).optional(),
  supplier: z.string().max(200).optional()
});
const Body = z.object({ rows: z.array(z.record(z.any())).min(1).max(2000) });

function num(v: unknown, def = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function itemType(v: unknown): "drug" | "equipment" {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "equipment" || s === "อุปกรณ์" ? "equipment" : "drug";
}
function freq(v: unknown): "R" | "Y" | "G" | null {
  const s = String(v ?? "").trim().toUpperCase();
  return s === "R" || s === "Y" || s === "G" ? s : null;
}

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const branchId = user.activeBranchId ?? null;
  const db = getDb();

  // supplier name → id (case-insensitive exact)
  const supRows = db.prepare(`
    SELECT id, name FROM inventa_suppliers
    WHERE active = 1 AND (branch_id IS ? OR branch_id = ?)
  `).all(branchId, branchId) as { id: number; name: string }[];
  const supByName = new Map(
    supRows.map((s) => [s.name.trim().toLowerCase(), s.id])
  );

  const insert = db.prepare(`
    INSERT INTO inventa_items
      (branch_id, item_code, barcode, name, generic_name, category,
       storage_location, item_type, unit, unit_cost, supplier_id,
       grid_row, grid_col, pick_freq, safety_stock, current_qty,
       created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  let created = 0;
  const errors: string[] = [];
  const tx = db.transaction((rows: Record<string, unknown>[]) => {
    rows.forEach((raw, idx) => {
      const r = Row.safeParse(raw);
      if (!r.success) {
        errors.push(`แถว ${idx + 1}: ${raw.name ?? "(ไม่มีชื่อ)"} — ข้อมูลไม่ถูกต้อง`);
        return;
      }
      const d = r.data;
      const supId = d.supplier
        ? supByName.get(d.supplier.trim().toLowerCase()) ?? null
        : null;
      const gc = d.grid_col ? num(d.grid_col, 0) : null;
      insert.run(
        branchId,
        d.item_code?.trim() || null,
        d.barcode?.trim() || null,
        d.name.trim(),
        d.generic_name?.trim() || null,
        d.category?.trim() || null,
        d.storage_location?.trim() || null,
        itemType(d.item_type),
        d.unit?.trim() || null,
        num(d.unit_cost, 0),
        supId,
        d.grid_row?.trim() || null,
        gc && gc >= 1 && gc <= 6 ? gc : null,
        freq(d.pick_freq),
        d.safety_stock != null ? num(d.safety_stock, 50) : 50,
        d.current_qty != null ? num(d.current_qty, 0) : 0,
        user.id
      );
      created += 1;
    });
  });
  tx(parsed.data.rows);

  return NextResponse.json({ ok: true, created, errors });
}
