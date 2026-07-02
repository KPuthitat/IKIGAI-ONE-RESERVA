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
};

/** Read a branch's DELIVERA settings, creating a default row on first access
 *  so callers always get a value. */
export function getBranchSettings(branchId: number): DeliveraBranchSettings {
  const db = getDb();
  let row = db
    .prepare("SELECT branch_id, promptpay_id, default_prep_minutes FROM delivera_branch_settings WHERE branch_id = ?")
    .get(branchId) as DeliveraBranchSettings | undefined;
  if (!row) {
    db.prepare("INSERT INTO delivera_branch_settings (branch_id) VALUES (?)").run(branchId);
    row = { branch_id: branchId, promptpay_id: null, default_prep_minutes: 20 };
  }
  return row;
}

export function setBranchSettings(
  branchId: number,
  patch: { promptpay_id?: string | null; default_prep_minutes?: number }
): void {
  const db = getDb();
  getBranchSettings(branchId); // ensure row exists
  const cur = getBranchSettings(branchId);
  db.prepare(
    `UPDATE delivera_branch_settings
       SET promptpay_id = ?, default_prep_minutes = ?, updated_at = CURRENT_TIMESTAMP
     WHERE branch_id = ?`
  ).run(
    patch.promptpay_id !== undefined ? patch.promptpay_id : cur.promptpay_id,
    patch.default_prep_minutes !== undefined ? patch.default_prep_minutes : cur.default_prep_minutes,
    branchId
  );
}
