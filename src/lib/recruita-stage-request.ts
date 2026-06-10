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
import type { ApplicationStage, PendingStageTag } from "./recruita";
import { notifyStageChange, notifyExecGroupStageChange } from "./recruita-notify";

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
  // Owner 2026-06-10: stage-change requests no longer expire — they wait
  // until a second admin approves/cancels. (No read-time GC sweep.)
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

/** Trim a full StageRequestRow down to the client-safe tag shape that
 *  the list + pipeline render. Keeps server-only joins out of the
 *  serialized props. */
export function toPendingTag(row: StageRequestRow): PendingStageTag {
  return {
    id: row.id,
    from_stage: row.from_stage,
    to_stage: row.to_stage,
    requested_by: row.requested_by,
    requester_name: row.requester_name,
    requester_prefix: row.requester_prefix,
    expires_at: row.expires_at
  };
}

/** Batch variant of getActivePendingRequest — returns a map keyed by
 *  application_id for every application that currently has a pending
 *  request, so the list + pipeline can render their tags in one query
 *  instead of N. Like the single getter it first GC-expires any pending
 *  row past its expires_at (a cheap global sweep). */
export function getActivePendingRequestsForApplications(
  applicationIds: number[]
): Map<number, StageRequestRow> {
  const map = new Map<number, StageRequestRow>();
  if (applicationIds.length === 0) return map;
  const db = getDb();
  // Owner 2026-06-10: no expiry GC — pending requests stay until decided.
  const placeholders = applicationIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT r.*,
           ur.display_name AS requester_name,
           ur.title_prefix AS requester_prefix,
           ua.display_name AS approver_name,
           ua.title_prefix AS approver_prefix
    FROM recruita_stage_change_requests r
    LEFT JOIN users ur ON ur.id = r.requested_by
    LEFT JOIN users ua ON ua.id = r.approver_user_id
    WHERE r.application_id IN (${placeholders})
      AND r.status = 'pending'
    ORDER BY r.requested_at ASC
  `).all(...applicationIds) as StageRequestRow[];

  // ASC order → if (defensively) more than one pending row exists for
  // an application, the most recent wins.
  for (const row of rows) map.set(row.application_id, row);
  return map;
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
  // Owner 2026-06-10: requests don't expire. expires_at is NOT NULL so we
  // still write it, but far in the future so any legacy check passes.
  const expiresAt = new Date(Date.now() + 100 * 365 * 24 * 3600 * 1000).toISOString();
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
  // Owner 2026-06-10: no expiry — a pending request stays valid until a
  // second admin approves or someone cancels it.
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
  // Also notify the exec group so owners follow pipeline movement.
  void notifyExecGroupStageChange(req.application_id).catch((e) => {
    console.warn("[recruita] notifyExecGroupStageChange after approval failed:", e);
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
