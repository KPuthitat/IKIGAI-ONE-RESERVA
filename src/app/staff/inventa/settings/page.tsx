import { requireSuperAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import type { InventaLookup, InventaSupplier } from "@/lib/inventa";
import SettingsClient from "./SettingsClient";

export const dynamic = "force-dynamic";

// /staff/inventa/settings — manage the option lists the item form
// uses: grid-row prefixes, storage cabinets, smallest-unit names,
// drug categories, and the supplier (ผู้สั่ง) directory.
export default function InventaSettingsPage() {
  const user = requireSuperAdmin();
  const db = getDb();
  const branchId = user.activeBranchId ?? null;

  const lookups = db.prepare(`
    SELECT * FROM inventa_lookups
    WHERE active = 1 AND (branch_id IS NULL OR branch_id = ?)
    ORDER BY kind, sort_order, value
  `).all(branchId) as InventaLookup[];

  const suppliers = db.prepare(`
    SELECT * FROM inventa_suppliers
    WHERE active = 1 AND (branch_id IS ? OR branch_id = ?)
    ORDER BY name
  `).all(branchId, branchId) as InventaSupplier[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">INVENTA · ตั้งค่า</h1>
        <p className="text-sm text-slate-500">
          จัดการตัวเลือกที่ใช้ในฟอร์มยา — แถว, ตำแหน่งเก็บ, หน่วยขาย,
          หมวดหมู่ยา, และบริษัทผู้จำหน่าย
        </p>
      </div>
      <SettingsClient lookups={lookups} suppliers={suppliers} />
    </div>
  );
}
