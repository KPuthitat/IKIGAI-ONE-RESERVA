import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import StockGrid, { type GridItem } from "../StockGrid";

export const dynamic = "force-dynamic";

// /staff/inventa/grid — visual shelf map (A1–E6) as its own menu. A
// locate tool: tap a cell to see what lives there. Editing stays in
// the คลังยา table page.
export default function InventaGridPage() {
  const user = requireUser();
  const db = getDb();
  const branchId = user.activeBranchId ?? null;

  const items = db.prepare(`
    SELECT id, name, generic_name, item_code, barcode, category,
           grid_row, grid_col, pick_freq, current_qty, safety_stock
    FROM inventa_items
    WHERE active = 1 AND (branch_id IS ? OR branch_id = ?)
    ORDER BY grid_row, grid_col, name
  `).all(branchId, branchId) as GridItem[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">INVENTA · ผังกริด (หาตำแหน่งยา)</h1>
        <p className="text-sm text-slate-500">
          แผนผังชั้นวาง A1–E6 — ค้นหายาแล้วดูว่าอยู่ช่องไหน หรือจิ้มช่องเพื่อดูยาในช่องนั้น
        </p>
      </div>
      <StockGrid items={items} />
    </div>
  );
}
