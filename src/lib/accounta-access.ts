// Per-user ACCOUNTA branch access (owner 2026-06-25). Separate from staff
// membership (user_branches): grant a bookkeeper the exact branches they may
// see/process in ACCOUNTA. Two levels — 'view' (read) and 'confirm' (may post
// scanned drafts into the ledger). super_admin is implicitly all-branches at
// 'confirm' and is never stored.
//
// Server-only (imports getDb).

import { getDb } from "./db";

export type AccessLevel = "none" | "view" | "confirm";

export type AccessRow = { user_id: number; branch_id: number; can_confirm: number };

const isSuper = (role: string) => role === "super_admin";

function allBranchIds(): number[] {
  return (getDb().prepare("SELECT id FROM branches ORDER BY id").all() as Array<{ id: number }>).map((b) => b.id);
}

/** branchId → level for this user. super_admin = every branch at 'confirm'. */
export function accountaAccessFor(userId: number, role: string): Map<number, AccessLevel> {
  const m = new Map<number, AccessLevel>();
  if (isSuper(role)) {
    for (const id of allBranchIds()) m.set(id, "confirm");
    return m;
  }
  const rows = getDb().prepare(
    "SELECT branch_id, can_confirm FROM accounta_access WHERE user_id = ?"
  ).all(userId) as Array<{ branch_id: number; can_confirm: number }>;
  for (const r of rows) m.set(r.branch_id, r.can_confirm ? "confirm" : "view");
  return m;
}

/** Branch ids this user can at least view in ACCOUNTA. */
export function accessibleBranchIds(userId: number, role: string): number[] {
  return [...accountaAccessFor(userId, role).keys()];
}

export function canAccessBranch(userId: number, role: string, branchId: number): boolean {
  return accountaAccessFor(userId, role).has(branchId);
}

export function canConfirmBranch(userId: number, role: string, branchId: number): boolean {
  return accountaAccessFor(userId, role).get(branchId) === "confirm";
}

/** Set (or clear) one user's access to one branch. level 'none' removes it. */
export function setAccountaAccess(
  userId: number, branchId: number, level: AccessLevel, grantedBy: number
): void {
  const db = getDb();
  if (level === "none") {
    db.prepare("DELETE FROM accounta_access WHERE user_id = ? AND branch_id = ?").run(userId, branchId);
    return;
  }
  db.prepare(`
    INSERT INTO accounta_access (user_id, branch_id, can_confirm, granted_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, branch_id) DO UPDATE SET can_confirm = excluded.can_confirm, granted_by = excluded.granted_by
  `).run(userId, branchId, level === "confirm" ? 1 : 0, grantedBy);
}

/** All explicit grants (for the admin matrix). super_admin rows are implicit. */
export function listAllAccountaAccess(): AccessRow[] {
  return getDb().prepare(
    "SELECT user_id, branch_id, can_confirm FROM accounta_access"
  ).all() as AccessRow[];
}
