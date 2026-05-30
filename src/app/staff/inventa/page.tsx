import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import type { InventaItem, InventaSupplier, InventaLookup } from "@/lib/inventa";
import InventaClient from "./InventaClient";

export const dynamic = "force-dynamic";

// /staff/inventa — INVENTA clinic stock module (Phase 1: catalogue +
// suppliers). Counting + reorder land in later phases. Branch-scoped
// to the user's active branch.
export default function InventaPage() {
  const user = requireUser();
  const lang = getLang();
  const db = getDb();
  const branchId = user.activeBranchId ?? null;

  // earliest_expiry: per item, the soonest still-positive-qty lot's
  // expiry. Drives the row tinting on the client (#93). Items with
  // no lots tracked at all have NULL, treated as "no_expiry".
  const items = db.prepare(`
    SELECT i.*, s.name AS supplier_name,
           (SELECT MIN(l.expiry_date)
              FROM inventa_item_lots l
              WHERE l.item_id = i.id AND l.qty > 0 AND l.expiry_date IS NOT NULL
           ) AS earliest_expiry
    FROM inventa_items i
    LEFT JOIN inventa_suppliers s ON s.id = i.supplier_id
    WHERE i.active = 1 AND (i.branch_id IS ? OR i.branch_id = ?)
    ORDER BY i.grid_row, i.grid_col, i.name
  `).all(branchId, branchId) as (InventaItem & {
    supplier_name: string | null;
    earliest_expiry: string | null;
  })[];

  const suppliers = db.prepare(`
    SELECT * FROM inventa_suppliers
    WHERE active = 1 AND branch_id = ?
    ORDER BY display_order ASC, name ASC
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
        <h1 className="text-2xl font-bold text-slate-800">{t(lang, "inv.stock.title")}</h1>
        <p className="text-sm text-slate-500">{t(lang, "inv.stock.subtitle")}</p>
      </div>
      <InventaClient items={items} suppliers={suppliers} lookups={lookups}
        isSuperAdmin={user.role === "super_admin"} />
    </div>
  );
}
