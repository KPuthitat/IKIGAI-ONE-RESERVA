// INVENTA waste log — DB reads/writes (server-only by usage: it calls getDb()).
// Log-only: nothing here mutates inventa_items.current_qty (owner 2026-09-22).

import { getDb } from "@/lib/db";
import type { WasteReason, WasteRow, WasteSummary, WasteReasonTotal, WasteItemTotal } from "@/lib/inventa-waste";

const r2 = (n: number) => Math.round(n * 100) / 100;

export type CreateWasteInput = {
  itemId?: number | null;      // a stock item → snapshot its name/unit/cost
  // Ad-hoc item not in the stock list (owner 2026-09-23) — used when itemId is null.
  itemName?: string;
  unit?: string | null;
  unitCost?: number;
  qty: number;
  reason: WasteReason;
  note?: string | null;
  wastedOn: string;        // YYYY-MM-DD
  photoPath?: string | null;   // stored filename from saveWastePhoto, or null
};

/** Record a waste event. For a stock item (itemId) it snapshots the item's
 *  name/unit/cost; for an ad-hoc item (no itemId) it uses the supplied
 *  name/unit/cost and stores item_id = NULL. Returns the new row id, or null
 *  when the stock item doesn't exist for this branch, or an ad-hoc name is blank. */
export function createWaste(branchId: number | null, input: CreateWasteInput, userId: number): number | null {
  const db = getDb();
  let itemId: number | null;
  let name: string, unit: string | null, unitCost: number;

  if (input.itemId != null) {
    const item = db.prepare(
      "SELECT name, unit, unit_cost FROM inventa_items WHERE id = ? AND (branch_id IS ? OR branch_id = ?)"
    ).get(input.itemId, branchId, branchId) as { name: string; unit: string | null; unit_cost: number } | undefined;
    if (!item) return null;
    itemId = input.itemId; name = item.name; unit = item.unit; unitCost = item.unit_cost ?? 0;
  } else {
    name = (input.itemName ?? "").trim();
    if (!name) return null;
    itemId = null; unit = input.unit?.trim() || null; unitCost = Math.max(0, input.unitCost ?? 0);
  }

  const info = db.prepare(`
    INSERT INTO inventa_waste (branch_id, item_id, item_name, unit, unit_cost, qty, reason, note, photo_path, wasted_on, logged_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    branchId, itemId, name, unit, unitCost,
    input.qty, input.reason, input.note?.trim() || null, input.photoPath ?? null, input.wastedOn, userId
  );
  return Number(info.lastInsertRowid);
}

/** Recent waste entries for the branch, newest first. */
export function listWaste(branchId: number | null, limit = 100): WasteRow[] {
  const rows = getDb().prepare(`
    SELECT w.id, w.item_id, w.item_name, w.unit, w.unit_cost, w.qty, w.reason, w.note,
           w.photo_path, w.wasted_on, w.created_at, u.display_name AS logged_by_name
    FROM inventa_waste w
    LEFT JOIN users u ON u.id = w.logged_by
    WHERE w.branch_id IS ? OR w.branch_id = ?
    ORDER BY w.wasted_on DESC, w.id DESC
    LIMIT ?
  `).all(branchId, branchId, limit) as Array<Omit<WasteRow, "value" | "photoUrl"> & { photo_path: string | null }>;
  return rows.map(({ photo_path, ...w }) => ({
    ...w,
    value: r2(w.qty * (w.unit_cost ?? 0)),
    photoUrl: photo_path ? `/api/inventa/waste/photo/${w.id}` : null
  }));
}

/** Monthly roll-up for the admin report: total value, by-reason, and top items. */
export function wasteSummary(branchId: number | null, month: string): WasteSummary {
  const db = getDb();
  const like = `${month}-%`;

  const totals = db.prepare(`
    SELECT COUNT(*) AS events, COALESCE(SUM(qty * unit_cost), 0) AS value
    FROM inventa_waste
    WHERE (branch_id IS ? OR branch_id = ?) AND wasted_on LIKE ?
  `).get(branchId, branchId, like) as { events: number; value: number };

  const byReason = db.prepare(`
    SELECT reason, COUNT(*) AS events, COALESCE(SUM(qty * unit_cost), 0) AS value
    FROM inventa_waste
    WHERE (branch_id IS ? OR branch_id = ?) AND wasted_on LIKE ?
    GROUP BY reason ORDER BY value DESC
  `).all(branchId, branchId, like) as Array<{ reason: WasteReason; events: number; value: number }>;

  const topItems = db.prepare(`
    SELECT item_name, COUNT(*) AS events, COALESCE(SUM(qty), 0) AS totalQty,
           COALESCE(SUM(qty * unit_cost), 0) AS value
    FROM inventa_waste
    WHERE (branch_id IS ? OR branch_id = ?) AND wasted_on LIKE ?
    GROUP BY item_name ORDER BY value DESC, events DESC
    LIMIT 10
  `).all(branchId, branchId, like) as Array<{ item_name: string; events: number; totalQty: number; value: number }>;

  return {
    month,
    totalValue: r2(totals.value),
    totalEvents: totals.events,
    byReason: byReason.map((b): WasteReasonTotal => ({ reason: b.reason, qtyEvents: b.events, value: r2(b.value) })),
    topItems: topItems.map((t): WasteItemTotal => ({ item_name: t.item_name, qtyEvents: t.events, totalQty: r2(t.totalQty), value: r2(t.value) }))
  };
}
