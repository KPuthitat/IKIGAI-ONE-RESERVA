import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import type { InventaItem, InventaSupplier, InventaLookup } from "@/lib/inventa";
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
    WHERE active = 1 AND branch_id = ?
    ORDER BY name
  `).all(branchId) as InventaSupplier[];

  // Per-branch only — no global/shared lookups.
  const lookups = db.prepare(`
    SELECT * FROM inventa_lookups
    WHERE active = 1 AND branch_id = ?
    ORDER BY kind, sort_order, value
  `).all(branchId) as InventaLookup[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">INVENTA · คลังสินค้า</h1>
        <p className="text-sm text-slate-500">
          ระบบบริหารคลังสินค้า — บันทึกรายการพร้อมบาร์โค้ด/คิวอาร์โค้ด
          กำหนดตำแหน่งจัดเก็บ แถบสี และต้นทุนต่อหน่วย รองรับการตรวจนับ
          และจัดทำใบสั่งซื้อ ใช้ได้กับทุกประเภทธุรกิจ
        </p>
      </div>
      <InventaClient items={items} suppliers={suppliers} lookups={lookups}
        isSuperAdmin={user.role === "super_admin"} />
    </div>
  );
}
