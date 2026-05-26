// Branch-level chain of command (2026-05).
//
// Owner direction: replace per-user reports_to_user_id with a 2-tier
// structure configured PER BRANCH. Concretely:
//
//   Tier 1 — หัวหน้างาน (supervisors). Any 1 of them can approve;
//            once one does, the request advances to tier 2.
//   Tier 2 — ผู้บริหาร (executives). Any 1 of them can approve;
//            once one does, the request is fully approved.
//
// Self-skip rule: if the requester is themselves in tier 1, the
// request starts at tier 2 (they can't sign off on their own leave).
// If the requester is in tier 2, the request still starts at tier 2
// but the requester is excluded from the eligible-approver set.
//
// No-fallback rule: if the branch doesn't have at least 1 user in
// each of tier 1 and tier 2, the submission API rejects with a clear
// error so an unconfigured branch can't silently route requests to
// super_admin. (Owner asked for hard fail; the cost of a stuck
// submission is acceptable vs the cost of routing to the wrong
// approver.)
//
// Old `users.reports_to_user_id` + `users.escalation_hours` columns
// remain in schema for backwards compat but no new code reads them.

import { getDb } from "./db";

export type TierLevel = 1 | 2;

export type TierMember = {
  user_id: number;
  display_name: string;
  title_prefix: string | null;
  nickname_th: string | null;
  role: string;
};

/** All members of a branch's tier, with display fields baked in for
 *  the admin config UI + LINE notification recipients list. */
export function getBranchTierMembers(
  branchId: number,
  tier: TierLevel
): TierMember[] {
  return getDb().prepare(`
    SELECT u.id AS user_id, u.display_name, u.title_prefix,
           u.nickname_th, u.role
    FROM branch_approval_tiers t
    INNER JOIN users u ON u.id = t.user_id
    WHERE t.branch_id = ? AND t.tier_level = ?
      AND u.status != 'disabled'
    ORDER BY u.display_name
  `).all(branchId, tier) as TierMember[];
}

/** Quick boolean — "does this branch have both tiers configured with
 *  at least one active user each?" Submission endpoints call this
 *  before accepting a new leave/resignation request. */
export function isBranchChainReady(branchId: number): boolean {
  const row = getDb().prepare(`
    SELECT
      SUM(CASE WHEN t.tier_level = 1 THEN 1 ELSE 0 END) AS t1,
      SUM(CASE WHEN t.tier_level = 2 THEN 1 ELSE 0 END) AS t2
    FROM branch_approval_tiers t
    INNER JOIN users u ON u.id = t.user_id
    WHERE t.branch_id = ? AND u.status != 'disabled'
  `).get(branchId) as { t1: number | null; t2: number | null } | undefined;
  return !!(row && (row.t1 ?? 0) > 0 && (row.t2 ?? 0) > 0);
}

/** Decide which tier a brand-new request should land in given the
 *  requester. Self-skip rule applies: if requester is in tier 1 they
 *  can't approve their own leave, so we start at tier 2. */
export function pickInitialTier(
  branchId: number,
  requesterUserId: number
): TierLevel {
  const isT1 = getDb().prepare(`
    SELECT 1 FROM branch_approval_tiers
    WHERE branch_id = ? AND tier_level = 1 AND user_id = ?
  `).get(branchId, requesterUserId);
  return isT1 ? 2 : 1;
}

/** True when the given user can approve a request currently at the
 *  given tier on the given branch. Excludes the requester themselves
 *  (a tier 2 user can't sign off on their own leave). super_admin
 *  bypasses this entirely (handled by canActOnRequestTiered below). */
export function isEligibleApprover(
  userId: number,
  branchId: number,
  tier: TierLevel,
  requesterUserId: number
): boolean {
  if (userId === requesterUserId) return false;
  const row = getDb().prepare(`
    SELECT 1 FROM branch_approval_tiers t
    INNER JOIN users u ON u.id = t.user_id
    WHERE t.branch_id = ? AND t.tier_level = ? AND t.user_id = ?
      AND u.status != 'disabled'
  `).get(branchId, tier, userId);
  return !!row;
}

/** Compose the canActOnRequest decision for tier-based routing.
 *  super_admin always passes; otherwise the user must be in the
 *  current tier (and not be the requester). */
export function canActOnRequestTiered(
  approverUser: { id: number; role: string },
  branchId: number,
  currentTier: TierLevel,
  requesterUserId: number
): boolean {
  if (approverUser.role === "super_admin") return true;
  return isEligibleApprover(approverUser.id, branchId, currentTier, requesterUserId);
}

/** Replace the tier set for a branch atomically. Caller passes the
 *  full desired roster for the tier; we wipe the old rows and insert
 *  the new ones inside a single transaction so we never leave the
 *  branch in a half-configured state. Used by the admin UI's save. */
export function setBranchTierMembers(
  branchId: number,
  tier: TierLevel,
  userIds: number[]
): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`
      DELETE FROM branch_approval_tiers
      WHERE branch_id = ? AND tier_level = ?
    `).run(branchId, tier);
    const ins = db.prepare(`
      INSERT INTO branch_approval_tiers (branch_id, tier_level, user_id)
      VALUES (?, ?, ?)
    `);
    // Deduplicate just in case the client double-submits the same id.
    const seen = new Set<number>();
    for (const uid of userIds) {
      if (seen.has(uid)) continue;
      seen.add(uid);
      ins.run(branchId, tier, uid);
    }
  });
  tx();
}

/** LINE-notification recipients list — every active user in the tier
 *  EXCEPT the requester. Returned as line_user_id only (caller pushes
 *  to LINE OA). Users without a bound LINE account are silently
 *  dropped from this list — fall back to in-app dashboard for them. */
export function getTierLineRecipients(
  branchId: number,
  tier: TierLevel,
  excludeUserId: number
): Array<{ user_id: number; line_user_id: string; display_name: string; nickname_th: string | null; title_prefix: string | null }> {
  return getDb().prepare(`
    SELECT u.id AS user_id, u.line_user_id, u.display_name,
           u.nickname_th, u.title_prefix
    FROM branch_approval_tiers t
    INNER JOIN users u ON u.id = t.user_id
    WHERE t.branch_id = ? AND t.tier_level = ?
      AND u.status != 'disabled'
      AND u.id != ?
      AND u.line_user_id IS NOT NULL
  `).all(branchId, tier, excludeUserId) as Array<{
    user_id: number;
    line_user_id: string;
    display_name: string;
    nickname_th: string | null;
    title_prefix: string | null;
  }>;
}
