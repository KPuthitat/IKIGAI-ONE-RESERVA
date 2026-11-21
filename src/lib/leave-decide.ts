// Deciding a leave request, shared by the web route and the LINE group secretary (owner 2026-11-21) so
// both go through exactly the same rules: branch guard, pending-only, approval tier, then the update and
// the notifications. The PIN check stays with the caller (the web asks for a PIN; the LINE group uses a
// confirm button bound to the person's LINE account).

import { getDb } from "./db";
import { notifyLeaveEvent } from "./approval-notify";
import { canActOnRequestTiered, type TierLevel } from "./approval-tiers";

export type Decision = "approved" | "rejected" | "revision_requested";
export type Actor = { id: number; role: string; branchIds: number[] };

export type LeaveRow = { user_id: number; status: string; branch_id: number | null; current_tier: number | null };
export type CheckResult =
  | { ok: true; row: LeaveRow }
  | { ok: false; error: "not_found" | "branch_forbidden" | "already_decided" | "not_in_approval_tier"; currentStatus?: string; tier?: number };

/** May this actor decide this request right now? (No writes.) */
export function checkLeaveDecision(id: number, actor: Actor): CheckResult {
  const row = getDb().prepare("SELECT user_id, status, branch_id, current_tier FROM leave_requests WHERE id = ?").get(id) as LeaveRow | undefined;
  if (!row) return { ok: false, error: "not_found" };
  // Branch guard: an admin only decides requests of branches they belong to (legacy NULL branch stays reachable).
  if (row.branch_id != null && !actor.branchIds.includes(row.branch_id)) return { ok: false, error: "branch_forbidden" };
  if (row.status !== "pending") return { ok: false, error: "already_decided", currentStatus: row.status };
  // Tier rule: on rows with a tier, the actor must be in that tier (or super_admin).
  if (row.current_tier != null && row.branch_id != null) {
    const tier = row.current_tier as TierLevel;
    if (!canActOnRequestTiered({ id: actor.id, role: actor.role }, row.branch_id, tier, row.user_id)) return { ok: false, error: "not_in_approval_tier", tier };
  }
  return { ok: true, row };
}

export type ApplyResult = { status: "pending"; tier: 2 } | { status: Decision };

/** Apply a decision that checkLeaveDecision allowed. Tier-1 approval only advances to tier 2. */
export function applyLeaveDecision(id: number, row: LeaveRow, actor: Actor, decision: Decision, note?: string | null): ApplyResult {
  const db = getDb();
  const nowIso = new Date().toISOString();
  if (decision === "approved" && row.current_tier === 1) {
    db.prepare("UPDATE leave_requests SET current_tier = 2, last_escalated_at = ? WHERE id = ?").run(nowIso, id);
    notifyLeaveEvent({ requestId: id, event: "tier_advanced" }).catch((e) => console.warn("leave notify (tier_advanced) failed", e));
    return { status: "pending", tier: 2 };
  }
  db.prepare("UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?").run(decision, actor.id, nowIso, note ?? null, id);
  if (decision === "approved" || decision === "rejected") {
    notifyLeaveEvent({ requestId: id, event: decision, decidedTier: (row.current_tier as TierLevel | null) ?? undefined })
      .catch((e) => console.warn("leave notify (decision) failed", e));
  }
  return { status: decision };
}
