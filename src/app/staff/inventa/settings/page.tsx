import { requireSuperAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import type { InventaLookup, InventaSupplier } from "@/lib/inventa";
import SettingsClient from "./SettingsClient";

export const dynamic = "force-dynamic";

// /staff/inventa/settings — manage the option lists the item form
// uses: grid-row prefixes, storage cabinets, smallest-unit names,
// drug categories, and the supplier (ผู้สั่ง) directory.
export default function InventaSettingsPage() {
  requireSuperAdmin();
  const db = getDb();

  // Load every scope (global + all branches); the client filters by
  // the chosen scope so super_admin can configure "ส่วนกลาง" or any
  // specific branch from one screen.
  const lookups = db.prepare(`
    SELECT * FROM inventa_lookups
    WHERE active = 1
    ORDER BY kind, sort_order, value
  `).all() as InventaLookup[];

  const suppliers = db.prepare(`
    SELECT * FROM inventa_suppliers
    WHERE active = 1
    ORDER BY name
  `).all() as InventaSupplier[];

  const branches = db.prepare(`
    SELECT id, name FROM branches ORDER BY display_order, name
  `).all() as Array<{ id: number; name: string }>;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">INVENTA · ตั้งค่า</h1>
        <p className="text-sm text-slate-500">
          จัดการตัวเลือกที่ใช้ในฟอร์มรายการ — แถว, ตำแหน่งจัดเก็บ, หน่วย,
          หมวดหมู่, และผู้จำหน่าย · เลือกได้ว่าตั้งให้ส่วนกลางหรือเฉพาะสาขา
        </p>
      </div>
      <SettingsClient lookups={lookups} suppliers={suppliers} branches={branches} />
    </div>
  );
}
