import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import type { InventaItem, InventaSupplier } from "@/lib/inventa";
import InventaClient from "./InventaClient";

export const dynamic = "force-dynamic";

// /staff/inventa — INVENTA clinic stock module (Phase 1: catalogue +
// suppliers). Counting + reorder land in later phases. Branch-scoped
// to the user's active branch.
export default function InventaPage() {
  const user = requireUser();
  const db = getDb();
  const branchId = user.activeBranchId ?? null;

  const items = db.prepare(`
    SELECT i.*, s.name AS supplier_name
    FROM inventa_items i
    LEFT JOIN inventa_suppliers s ON s.id = i.supplier_id
    WHERE i.active = 1 AND (i.branch_id IS ? OR i.branch_id = ?)
    ORDER BY i.grid_row, i.grid_col, i.name
  `).all(branchId, branchId) as (InventaItem & { supplier_name: string | null })[];

  const suppliers = db.prepare(`
    SELECT * FROM inventa_suppliers
    WHERE active = 1 AND (branch_id IS ? OR branch_id = ?)
    ORDER BY name
  `).all(branchId, branchId) as InventaSupplier[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">INVENTA · คลังยา/อุปกรณ์</h1>
        <p className="text-sm text-slate-500">
          ระบบนับสต๊อกคลินิก — บาร์โค้ด · ตำแหน่ง grid (แถว A–E × คอลัมน์ 1–6) ·
          สีหยิบใช้ R/Y/G · ราคาทุนต่อหน่วยเล็กสุด
        </p>
      </div>
      <InventaClient items={items} suppliers={suppliers} />
    </div>
  );
}
