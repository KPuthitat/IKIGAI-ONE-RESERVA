// Server-side helpers for RECRUITA stage-change requests.
//
// Two-admin approval flow:
//   1. Admin A clicks a stage button → createStageRequest() →
//      row goes into recruita_stage_change_requests with status='pending'
//      and a 24h expires_at. Application stage is NOT yet changed.
//   2. Admin B (different user from A) opens the same application,
//      sees the pending request, enters their PIN →
//      approveStageRequest() → status='approved', application stage
//      flips to to_stage, notifyStageChange fires.
//   3. If the request hits expires_at without approval, it's marked
//      expired at read time.
//
// All functions assume the caller already verified the user's PIN
// against verifyAdminPin() — this module is the storage layer.

import { getDb } from "./db";
import type { ApplicationStage } from "./recruita";
import { notifyStageChange } from "./recruita-notify";

/** How long a pending request stays valid before it's auto-expired. */
const REQUEST_TTL_HOURS = 24;

export type StageRequestRow = {
  id: number;
  application_id: number;
  from_stage: ApplicationStage;
  to_stage: ApplicationStage;
  requested_by: number;
  requested_at: string;
  approver_user_id: number | null;
  approver_at: string | null;
  cancelled_by: number | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  expires_at: string;
  status: "pending" | "approved" | "cancelled" | "expired";
  /** Joined display names so the UI can render the request banner
   *  without a second round-trip. */
  requester_name: string | null;
  requester_prefix: string | null;
  approver_name: string | null;
  approver_prefix: string | null;
};

/** Return the active pending request for an application, or null.
 *  Side-effect: silently flips any pending row whose expires_at is
 *  in the past to status='expired' (read-time GC). */
export function getActivePendingRequest(applicationId: number): StageRequestRow | null {
  const db = getDb();
  // GC sweep — cheap, only touches expired rows for this application.
  db.prepare(`
    UPDATE recruita_stage_change_requests
       SET status = 'expired'
     WHERE application_id = ?
       AND status = 'pending'
       AND expires_at < CURRENT_TIMESTAMP
  `).run(applicationId);

  const row = db.prepare(`
    SELECT r.*,
           ur.display_name AS requester_name,
           ur.title_prefix AS requester_prefix,
           ua.display_name AS approver_name,
           ua.title_prefix AS approver_prefix
    FROM recruita_stage_change_requests r
    LEFT JOIN users ur ON ur.id = r.requested_by
    LEFT JOIN users ua ON ua.id = r.approver_user_id
    WHERE r.application_id = ?
      AND r.status = 'pending'
    ORDER BY r.requested_at DESC
    LIMIT 1
  `).get(applicationId) as StageRequestRow | undefined;
  return row ?? null;
}

/** Create a new pending request. Caller has verified the requester's
 *  PIN. Refuses when an active pending request already exists for
 *  this application so a single admin can't queue up multiple stage
 *  changes — they must cancel the existing request first. */
export function createStageRequest(args: {
  applicationId: number;
  fromStage: ApplicationStage;
  toStage: ApplicationStage;
  requestedBy: number;
}): { ok: true; requestId: number } | { ok: false; error: string } {
  if (args.fromStage === args.toStage) {
    return { ok: false, error: "same_stage" };
  }
  const existing = getActivePendingRequest(args.applicationId);
  if (existing) {
    return { ok: false, error: "pending_request_exists" };
  }
  const db = getDb();
  const expiresAt = new Date(Date.now() + REQUEST_TTL_HOURS * 3600 * 1000).toISOString();
  const info = db.prepare(`
    INSERT INTO recruita_stage_change_requests
      (application_id, from_stage, to_stage, requested_by, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(args.applicationId, args.fromStage, args.toStage, args.requestedBy, expiresAt);
  return { ok: true, requestId: Number(info.lastInsertRowid) };
}

/** Approve a pending request. The approver MUST be a different user
 *  than the requester (the "two-different-people" gate). Caller has
 *  verified the approver's PIN. On success: flips status to 'approved'
 *  + updates application.stage + fires notifyStageChange. */
export async function approveStageRequest(args: {
  requestId: number;
  approverUserId: number;
}): Promise<{ ok: true; toStage: ApplicationStage } | { ok: false; error: string }> {
  const db = getDb();
  const req = db.prepare(`
    SELECT id, application_id, from_stage, to_stage, requested_by, status, expires_at
    FROM recruita_stage_change_requests
    WHERE id = ?
  `).get(args.requestId) as {
    id: number;
    application_id: number;
    from_stage: ApplicationStage;
    to_stage: ApplicationStage;
    requested_by: number;
    status: string;
    expires_at: string;
  } | undefined;
  if (!req) return { ok: false, error: "not_found" };
  if (req.status !== "pending") return { ok: false, error: `status_${req.status}` };
  if (new Date(req.expires_at).getTime() < Date.now()) {
    // Mark expired so future reads see the right state.
    db.prepare("UPDATE recruita_stage_change_requests SET status = 'expired' WHERE id = ?")
      .run(args.requestId);
    return { ok: false, error: "expired" };
  }
  if (req.requested_by === args.approverUserId) {
    return { ok: false, error: "same_user_cannot_approve" };
  }
  // Sanity — the application's CURRENT stage should still match the
  // request's from_stage. If somebody bypassed this flow (super-admin
  // emergency endpoint), the request is stale.
  const current = db.prepare("SELECT stage FROM recruita_applications WHERE id = ?")
    .get(req.application_id) as { stage: ApplicationStage } | undefined;
  if (!current) return { ok: false, error: "application_not_found" };
  if (current.stage !== req.from_stage) {
    db.prepare("UPDATE recruita_stage_change_requests SET status = 'expired' WHERE id = ?")
      .run(args.requestId);
    return { ok: false, error: "stage_changed_under_us" };
  }

  // Commit atomically — both the approval row and the application
  // row must move together, or neither does.
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE recruita_stage_change_requests
         SET status = 'approved',
             approver_user_id = ?,
             approver_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(args.approverUserId, args.requestId);
    db.prepare(`
      UPDATE recruita_applications
         SET stage = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(req.to_stage, req.application_id);
  });
  tx();

  // Fire-and-forget LINE push to the candidate. Mirrors the existing
  // direct-stage endpoint behaviour.
  void notifyStageChange(req.application_id).catch((e) => {
    console.warn("[recruita] notifyStageChange after approval failed:", e);
  });

  return { ok: true, toStage: req.to_stage };
}

/** Cancel a pending request. Allowed for: the requester themselves,
 *  or any super_admin. */
export function cancelStageRequest(args: {
  requestId: number;
  cancelledBy: number;
  reason?: string;
  isSuperAdmin: boolean;
}): { ok: true } | { ok: false; error: string } {
  const db = getDb();
  const req = db.prepare(`
    SELECT id, requested_by, status FROM recruita_stage_change_requests WHERE id = ?
  `).get(args.requestId) as { id: number; requested_by: number; status: string } | undefined;
  if (!req) return { ok: false, error: "not_found" };
  if (req.status !== "pending") return { ok: false, error: `status_${req.status}` };
  if (req.requested_by !== args.cancelledBy && !args.isSuperAdmin) {
    return { ok: false, error: "forbidden" };
  }
  db.prepare(`
    UPDATE recruita_stage_change_requests
       SET status = 'cancelled',
           cancelled_by = ?,
           cancelled_at = CURRENT_TIMESTAMP,
           cancel_reason = ?
     WHERE id = ?
  `).run(args.cancelledBy, args.reason ?? null, args.requestId);
  return { ok: true };
}
