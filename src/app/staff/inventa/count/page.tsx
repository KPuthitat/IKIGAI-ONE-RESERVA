import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import CountClient, { type CountItem } from "./CountClient";

export const dynamic = "force-dynamic";

// /staff/inventa/count — weekly stock count (เช็คสต๊อกรายสัปดาห์,
// ทุกศุกร์). Scan an item (camera or barcode gun) or pick from the
// list, type the counted qty; each save writes straight back to
// current_qty. Submit locks the session for history.
export default function InventaCountPage() {
  const user = requireUser();
  const lang = getLang();
  const db = getDb();
  const branchId = user.activeBranchId ?? null;

  const items = db.prepare(`
    SELECT id, item_code, barcode, name, generic_name, unit,
           grid_row, grid_col, pick_freq, current_qty, safety_stock
    FROM inventa_items
    WHERE active = 1 AND (branch_id IS ? OR branch_id = ?)
    ORDER BY grid_row, grid_col, name
  `).all(branchId, branchId) as CountItem[];

  const session = db.prepare(`
    SELECT id, count_date FROM inventa_counts
    WHERE status = 'open' AND (branch_id IS ? OR branch_id = ?)
    ORDER BY id DESC LIMIT 1
  `).get(branchId, branchId) as { id: number; count_date: string } | undefined;

  let countedMap: Record<number, number> = {};
  if (session) {
    const lines = db.prepare(
      "SELECT item_id, counted_qty FROM inventa_count_lines WHERE count_id = ?"
    ).all(session.id) as { item_id: number; counted_qty: number }[];
    countedMap = Object.fromEntries(lines.map((l) => [l.item_id, l.counted_qty]));
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">{t(lang, "inv.count.title")}</h1>
        <p className="text-sm text-slate-500">{t(lang, "inv.count.subtitle")}</p>
      </div>
      <CountClient
        items={items}
        session={session ?? null}
        initialCounted={countedMap}
      />
    </div>
  );
}
