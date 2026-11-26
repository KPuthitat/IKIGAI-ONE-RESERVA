// Stock helpers shared by purchasing (owner 2026-11-26): what is low, and adding received quantities to on-hand.
// Quantities are in each item's smallest unit — the same unit current_qty is counted in. Fractional items (count_mode 'fractional')
// are kept in whole bottles in qty_frac, exactly as the INVENTA PO flow does it.
import { getDb } from "./db";

export type LowStockItem = {
  itemId: number; name: string; unit: string; onHand: number; safety: number; suggestQty: number; unitCost: number; supplierId: number | null; supplierName: string | null; fractional: boolean;
};

/** Active items of the branch that are below their safety stock — what a purchase memo is usually about. Fractional items are skipped (their safety is a % of a bottle). */
export function lowStockItems(branchId: number): LowStockItem[] {
  const rows = getDb().prepare(`
    SELECT i.id, i.name, COALESCE(i.unit, '') AS unit, i.current_qty, i.safety_stock, i.unit_cost, i.cost_price, i.supplier_id, s.name AS supplier_name, i.count_mode
      FROM inventa_items i LEFT JOIN inventa_suppliers s ON s.id = i.supplier_id
     WHERE i.active = 1 AND i.branch_id = ? AND COALESCE(i.count_mode, 'discrete') <> 'fractional' AND i.current_qty < i.safety_stock
     ORDER BY s.name, i.name`).all(branchId) as Array<{ id: number; name: string; unit: string; current_qty: number; safety_stock: number; unit_cost: number; cost_price: number | null; supplier_id: number | null; supplier_name: string | null; count_mode: string | null }>;
  return rows.map((r) => ({ itemId: r.id, name: r.name, unit: r.unit, onHand: r.current_qty, safety: r.safety_stock, suggestQty: Math.max(1, r.safety_stock - r.current_qty),
    unitCost: r.cost_price ?? r.unit_cost ?? 0, supplierId: r.supplier_id, supplierName: r.supplier_name, fractional: false }));
}

/** Add received quantity to an item's on-hand. MUST run inside the caller's transaction. */
export function addStockQty(itemId: number, qty: number): boolean {
  if (!(qty > 0)) return false;
  const db = getDb();
  const it = db.prepare("SELECT count_mode FROM inventa_items WHERE id = ?").get(itemId) as { count_mode: string | null } | undefined;
  if (!it) return false;
  if (it.count_mode === "fractional") db.prepare("UPDATE inventa_items SET qty_frac = COALESCE(qty_frac, 0) + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(qty, itemId);
  else db.prepare("UPDATE inventa_items SET current_qty = current_qty + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(Math.round(qty), itemId);
  return true;
}
