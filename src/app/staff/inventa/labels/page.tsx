import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import LabelsClient, { type LabelItem } from "./LabelsClient";

export const dynamic = "force-dynamic";

// /staff/inventa/labels — printable QR labels. Each label encodes the
// item_code (fallback barcode) so the same scanner used for counting
// resolves it. Print → stick on the shelf bin. New staff scan the
// label to pull the item up instantly.
export default function InventaLabelsPage() {
  const user = requireUser();
  const lang = getLang();
  const db = getDb();
  const branchId = user.activeBranchId ?? null;

  const rawItems = db.prepare(`
    SELECT i.id, i.item_code, i.barcode, i.name, i.grid_row, i.grid_col, i.pick_freq,
           i.unit, i.cost_price, i.unit_cost, i.price_opd,
           i.category, i.storage_location, s.name AS supplier_name
    FROM inventa_items i
    LEFT JOIN inventa_suppliers s ON s.id = i.supplier_id
    WHERE i.active = 1 AND (i.branch_id IS ? OR i.branch_id = ?)
    ORDER BY i.grid_row, i.grid_col, i.name
  `).all(branchId, branchId) as Array<
    LabelItem & { cost_price: number | null; unit_cost: number | null; price_opd: number | null }
  >;
  // Label shows BOTH prices so a sticker is usable when the system is
  // unreachable (owner 2026-06-08, "เผื่อไฟดับ"):
  //   • ราคาทุน  = pinned cost_price, else derived unit_cost
  //   • ราคาขาย  = price_opd (the selling price)
  const items: LabelItem[] = rawItems.map((r) => ({
    ...r,
    cost: r.cost_price ?? r.unit_cost ?? null,
    sale: r.price_opd ?? null
  }));

  // Per-branch label print size (owner 2026-06-08), default 80×50 mm + the
  // drag-designed layout JSON (owner 2026-06-09), null = built-in layout.
  const size = branchId
    ? (db.prepare("SELECT inventa_label_width_mm AS w, inventa_label_height_mm AS h, inventa_label_layout AS layout FROM branches WHERE id = ?")
        .get(branchId) as { w: number; h: number; layout: string | null } | undefined)
    : undefined;

  return (
    <div className="space-y-4">
      <div className="no-print pl-11 md:pl-0">
        <h1 className="text-2xl font-bold text-slate-800">{t(lang, "inv.qr.title")}</h1>
        <p className="text-sm text-slate-500">{t(lang, "inv.qr.subtitle")}</p>
      </div>
      <LabelsClient
        items={items}
        widthMm={size?.w ?? 80}
        heightMm={size?.h ?? 50}
        layoutJson={size?.layout ?? null}
      />
    </div>
  );
}
