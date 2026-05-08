// Zone helpers — used to group tables per branch.
//
// A zone is a physical area of a restaurant: ชั้น 1, ชั้น 2, Outdoor, VIP, etc.
// Each branch defines its own zones. Tables get zone_id set in the floor-plan
// editor; tables without a zone (legacy data) appear in a "ไม่ระบุโซน" bucket
// in the timetable view.

import { getDb, type Zone } from "./db";

/** All zones for a branch, ordered by display_order then name. */
export function listZonesForBranch(branchId: number, opts?: { includeInactive?: boolean }): Zone[] {
  const where = opts?.includeInactive
    ? "WHERE branch_id = ?"
    : "WHERE branch_id = ? AND active = 1";
  return getDb().prepare(`
    SELECT * FROM zones ${where}
    ORDER BY display_order, name
  `).all(branchId) as Zone[];
}

export function getZoneById(id: number): Zone | null {
  const row = getDb().prepare("SELECT * FROM zones WHERE id = ?").get(id) as Zone | undefined;
  return row ?? null;
}

/** Insert or update a zone. Returns the zone id. */
export function upsertZone(args: {
  id?: number;
  branch_id: number;
  name: string;
  description?: string | null;
  display_order?: number;
  active?: 0 | 1;
}): number {
  const db = getDb();
  if (args.id) {
    db.prepare(`
      UPDATE zones
      SET name = ?, description = ?, display_order = ?, active = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      args.name,
      args.description ?? null,
      args.display_order ?? 100,
      args.active ?? 1,
      args.id
    );
    return args.id;
  }
  const result = db.prepare(`
    INSERT INTO zones (branch_id, name, description, display_order, active)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    args.branch_id,
    args.name,
    args.description ?? null,
    args.display_order ?? 100,
    args.active ?? 1
  );
  return result.lastInsertRowid as number;
}

/** Soft-delete (set active=0). Tables in this zone keep their zone_id but
 *  the zone won't appear in lists by default. */
export function deactivateZone(id: number): void {
  getDb().prepare("UPDATE zones SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
}

/** Hard-delete: removes the zone row. Cascades zone_id to NULL on tables
 *  via the foreign-key ON DELETE SET NULL. */
export function deleteZone(id: number): void {
  getDb().prepare("DELETE FROM zones WHERE id = ?").run(id);
}
