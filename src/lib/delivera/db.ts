import { getDb } from "@/lib/db";

// DELIVERA shared server helpers. Branch isolation in this repo is enforced in
// the APP LAYER (session + requirePermission + WHERE branch_id = ?), replacing
// the Postgres RLS the original spec assumed. Every DELIVERA query is scoped to
// a branch the caller may access — callers must pass a branch the session owns.

/** Feature gate — true only when the branch has DELIVERA switched on. Mirrors
 *  isRevshareBranch() in revshare-db.ts. */
export function isDeliveraBranch(branchId: number): boolean {
  const r = getDb()
    .prepare("SELECT delivera_enabled FROM branches WHERE id = ?")
    .get(branchId) as { delivera_enabled: number } | undefined;
  return Boolean(r && r.delivera_enabled === 1);
}

export type DeliveraBranchSettings = {
  branch_id: number;
  promptpay_id: string | null;
  default_prep_minutes: number;
  hook_deduct_stock: number;
  hook_post_income: number;
  hook_record_insigna: number;
};

/** Read a branch's DELIVERA settings, creating a default row on first access
 *  so callers always get a value. */
export function getBranchSettings(branchId: number): DeliveraBranchSettings {
  const db = getDb();
  let row = db
    .prepare("SELECT branch_id, promptpay_id, default_prep_minutes, hook_deduct_stock, hook_post_income, hook_record_insigna FROM delivera_branch_settings WHERE branch_id = ?")
    .get(branchId) as DeliveraBranchSettings | undefined;
  if (!row) {
    db.prepare("INSERT INTO delivera_branch_settings (branch_id) VALUES (?)").run(branchId);
    row = { branch_id: branchId, promptpay_id: null, default_prep_minutes: 20, hook_deduct_stock: 0, hook_post_income: 0, hook_record_insigna: 0 };
  }
  return row;
}

export function setBranchSettings(
  branchId: number,
  patch: {
    promptpay_id?: string | null; default_prep_minutes?: number;
    hook_deduct_stock?: boolean; hook_post_income?: boolean; hook_record_insigna?: boolean;
  }
): void {
  const db = getDb();
  const cur = getBranchSettings(branchId); // ensure row exists + read current
  const bit = (v: boolean | undefined, curVal: number) => (v === undefined ? curVal : v ? 1 : 0);
  db.prepare(
    `UPDATE delivera_branch_settings
       SET promptpay_id = ?, default_prep_minutes = ?,
           hook_deduct_stock = ?, hook_post_income = ?, hook_record_insigna = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE branch_id = ?`
  ).run(
    patch.promptpay_id !== undefined ? patch.promptpay_id : cur.promptpay_id,
    patch.default_prep_minutes !== undefined ? patch.default_prep_minutes : cur.default_prep_minutes,
    bit(patch.hook_deduct_stock, cur.hook_deduct_stock),
    bit(patch.hook_post_income, cur.hook_post_income),
    bit(patch.hook_record_insigna, cur.hook_record_insigna),
    branchId
  );
}

/** Enable/disable DELIVERA for a branch (owner flips this to go live/dark). */
export function setDeliveraEnabled(branchId: number, enabled: boolean): void {
  const db = getDb();
  db.prepare("UPDATE branches SET delivera_enabled = ? WHERE id = ?").run(enabled ? 1 : 0, branchId);
  if (enabled) {
    getBranchSettings(branchId);   // ensure a settings row exists
    const n = (db.prepare("SELECT COUNT(*) AS n FROM delivery_zones WHERE branch_id = ?").get(branchId) as { n: number }).n;
    if (n === 0) {
      const ins = db.prepare("INSERT INTO delivery_zones (branch_id, name, max_distance_km, base_fee, per_km_fee, min_order_amount) VALUES (?,?,?,?,?,?)");
      ins.run(branchId, "โซนใกล้ (≤3 กม.)", 3, 20, 0, 100);
      ins.run(branchId, "โซนไกล (≤7 กม.)", 7, 30, 8, 150);
    }
  }
}

// ─── Delivery zones CRUD ─────────────────────────────────────────────────────

export type ZoneRow = {
  id: number; branch_id: number; name: string; max_distance_km: number;
  base_fee: number; per_km_fee: number; min_order_amount: number; is_active: number;
};

export function listZones(branchId: number): ZoneRow[] {
  return getDb().prepare("SELECT * FROM delivery_zones WHERE branch_id = ? ORDER BY max_distance_km").all(branchId) as ZoneRow[];
}

export function createZone(branchId: number, z: { name: string; max_distance_km: number; base_fee: number; per_km_fee: number; min_order_amount: number }): number {
  const info = getDb().prepare(
    "INSERT INTO delivery_zones (branch_id, name, max_distance_km, base_fee, per_km_fee, min_order_amount) VALUES (?,?,?,?,?,?)"
  ).run(branchId, z.name, z.max_distance_km, z.base_fee, z.per_km_fee, z.min_order_amount);
  return Number(info.lastInsertRowid);
}

export function updateZone(id: number, branchId: number, patch: Partial<{ name: string; max_distance_km: number; base_fee: number; per_km_fee: number; min_order_amount: number; is_active: boolean }>): boolean {
  const cur = getDb().prepare("SELECT * FROM delivery_zones WHERE id = ? AND branch_id = ?").get(id, branchId) as ZoneRow | undefined;
  if (!cur) return false;
  return getDb().prepare(
    "UPDATE delivery_zones SET name=?, max_distance_km=?, base_fee=?, per_km_fee=?, min_order_amount=?, is_active=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND branch_id=?"
  ).run(
    patch.name ?? cur.name, patch.max_distance_km ?? cur.max_distance_km, patch.base_fee ?? cur.base_fee,
    patch.per_km_fee ?? cur.per_km_fee, patch.min_order_amount ?? cur.min_order_amount,
    patch.is_active !== undefined ? (patch.is_active ? 1 : 0) : cur.is_active, id, branchId
  ).changes > 0;
}

export function deleteZone(id: number, branchId: number): boolean {
  return getDb().prepare("DELETE FROM delivery_zones WHERE id = ? AND branch_id = ?").run(id, branchId).changes > 0;
}
