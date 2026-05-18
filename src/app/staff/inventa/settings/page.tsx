import { requireSuperAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import type { InventaLookup, InventaSupplier } from "@/lib/inventa";
import SettingsClient from "./SettingsClient";

export const dynamic = "force-dynamic";

// /staff/inventa/settings — per-branch option lists the item form
// uses: storage locations, unit names, categories, and the supplier
// directory. Everything is scoped to the active branch — there is no
// shared/global scope; each branch keeps its own distinct setup.
export default function InventaSettingsPage() {
  const user = requireSuperAdmin();
  const db = getDb();
  const branchId = user.activeBranchId ?? null;

  const branch = branchId
    ? (db.prepare("SELECT name FROM branches WHERE id = ?")
        .get(branchId) as { name: string } | undefined)
    : undefined;

  if (!branchId || !branch) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-slate-800">INVENTA · ตั้งค่า</h1>
        <div className="card text-sm text-amber-700">
          ยังไม่ได้เลือกสาขา — กดเปลี่ยนสาขาที่แถบด้านบนก่อน
          แล้วจึงตั้งค่า INVENTA ของสาขานั้น
        </div>
      </div>
    );
  }

  const lookups = db.prepare(`
    SELECT * FROM inventa_lookups
    WHERE active = 1 AND branch_id = ?
    ORDER BY kind, sort_order, value
  `).all(branchId) as InventaLookup[];

  const suppliers = db.prepare(`
    SELECT * FROM inventa_suppliers
    WHERE active = 1 AND branch_id = ?
    ORDER BY name
  `).all(branchId) as InventaSupplier[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">INVENTA · ตั้งค่า</h1>
        <p className="text-sm text-slate-500">
          กำหนดตัวเลือกที่ใช้ในฟอร์มรายการสินค้าของสาขานี้ — ตำแหน่งจัดเก็บ,
          หน่วยนับ, หมวดหมู่ และผู้จำหน่าย · แต่ละสาขาตั้งค่าของตัวเองแยกกัน
        </p>
      </div>
      <SettingsClient
        lookups={lookups}
        suppliers={suppliers}
        branchName={branch.name}
      />
    </div>
  );
}
