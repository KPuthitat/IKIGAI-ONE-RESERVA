import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import LabelsClient, { type LabelItem } from "./LabelsClient";

export const dynamic = "force-dynamic";

// /staff/inventa/labels — printable QR labels. Each label encodes the
// item_code (fallback barcode) so the same scanner used for counting
// resolves it. Print → stick on the shelf bin. New staff scan the
// label to pull the item up instantly.
export default function InventaLabelsPage() {
  const user = requireUser();
  const db = getDb();
  const branchId = user.activeBranchId ?? null;

  const items = db.prepare(`
    SELECT id, item_code, barcode, name, grid_row, grid_col, pick_freq
    FROM inventa_items
    WHERE active = 1 AND (branch_id IS ? OR branch_id = ?)
    ORDER BY grid_row, grid_col, name
  `).all(branchId, branchId) as LabelItem[];

  return (
    <div className="space-y-4">
      <div className="no-print">
        <h1 className="text-2xl font-bold text-slate-800">INVENTA · พิมพ์ QR ติดชั้น</h1>
        <p className="text-sm text-slate-500">
          QR แต่ละดวงเก็บ "รหัสสินค้า" — สแกนแล้วระบบเปิดรายการนั้นทันที
          (ใช้สแกนตอนนับได้เลย) · เลือกพิมพ์แล้วบันทึกเป็น PDF ก็ได้
        </p>
      </div>
      <LabelsClient items={items} />
    </div>
  );
}
