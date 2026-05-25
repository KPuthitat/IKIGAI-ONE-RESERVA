// Chain-of-command helper for staff approvals (leave + resignation,
// future: time-cert, discipline appeals, etc.).
//
// Each user can declare `reports_to_user_id` — their direct manager.
// When a request is created we set `current_approver_user_id` to the
// requester's manager. If that manager doesn't decide within their
// `escalation_hours` (or the system default), a nightly cron sweep
// escalates by reassigning to the manager's manager. The chain ends
// at the first super_admin we walk into; if the chain breaks before
// we reach one, we fall back to ANY super_admin so a request never
// hangs orphaned.
//
// approval_history is a JSON array stored on the request row:
//   [{ user_id, level, assigned_at, escalated_from?: number }]
// Level 0 = first assignee; each escalation increments by 1. The UI
// can read it back to show "Currently with: <name> · Level 2 · Past:
// <name1> (24h), <name2> (24h)".

import { getDb, type User } from "./db";

export type ApprovalAssignment = {
  approver_user_id: number;
  level: number;
  reason: "initial" | "escalation" | "fallback";
};

type ApprovalHistoryEntry = {
  user_id: number;
  level: number;
  assigned_at: string;
  escalated_from?: number;
};

/** Pick the first approver for a brand-new request. Returns the
 *  requester's direct manager (reports_to_user_id), or — when the
 *  requester has no manager set OR the manager has been deactivated —
 *  the first super_admin we can find. Throws if there's literally no
 *  super_admin in the system (initial-install edge case; caller
 *  should handle this by returning a 500 with a clear error). */
export function pickInitialApprover(requesterUserId: number): ApprovalAssignment {
  const db = getDb();
  const requester = db.prepare(
    "SELECT reports_to_user_id FROM users WHERE id = ?"
  ).get(requesterUserId) as { reports_to_user_id: number | null } | undefined;

  // Direct manager — must still exist + be active for us to route to them.
  if (requester?.reports_to_user_id) {
    const mgr = db.prepare(
      "SELECT id, active FROM users WHERE id = ?"
    ).get(requester.reports_to_user_id) as { id: number; active: number } | undefined;
    if (mgr && mgr.active) {
      return { approver_user_id: mgr.id, level: 0, reason: "initial" };
    }
  }

  // Fallback to any super_admin so the request doesn't orphan.
  const su = db.prepare(
    "SELECT id FROM users WHERE role = 'super_admin' AND active = 1 ORDER BY id LIMIT 1"
  ).get() as { id: number } | undefined;
  if (!su) throw new Error("No super_admin available to take the approval");
  return { approver_user_id: su.id, level: 0, reason: "fallback" };
}

/** Walk one step up the chain from the current approver. Returns
 *  null when we've already reached the top (super_admin) — the
 *  caller should leave the request with the current approver and
 *  maybe LINE them again as a reminder.
 *
 *  Skips deactivated users at each step so an old manager record
 *  doesn't dead-end the escalation. If the entire walk produces no
 *  active higher-up, we fall through to the first super_admin. */
export function escalateOneStep(
  currentApproverUserId: number,
  currentLevel: number
): ApprovalAssignment | null {
  const db = getDb();
  let cursor = currentApproverUserId;
  for (let hops = 0; hops < 10; hops++) {
    const next = db.prepare(`
      SELECT reports_to_user_id, role FROM users WHERE id = ?
    `).get(cursor) as { reports_to_user_id: number | null; role: string } | undefined;
    if (!next) break;
    // Already at the top of an explicit chain.
    if (!next.reports_to_user_id) {
      // super_admin = ceiling, nothing higher to escalate to.
      if (next.role === "super_admin") return null;
      break;
    }
    const mgr = db.prepare(
      "SELECT id, active, role FROM users WHERE id = ?"
    ).get(next.reports_to_user_id) as
      | { id: number; active: number; role: string }
      | undefined;
    if (!mgr || !mgr.active) {
      // Skip deactivated manager and walk further up.
      cursor = next.reports_to_user_id;
      continue;
    }
    return {
      approver_user_id: mgr.id,
      level: currentLevel + 1,
      reason: "escalation"
    };
  }
  // Last-resort: any super_admin.
  const su = db.prepare(
    "SELECT id FROM users WHERE role = 'super_admin' AND active = 1 AND id != ? ORDER BY id LIMIT 1"
  ).get(currentApproverUserId) as { id: number } | undefined;
  if (!su) return null;
  return { approver_user_id: su.id, level: currentLevel + 1, reason: "fallback" };
}

/** Look up the escalation window for an approver — their per-user
 *  override, falling back to system_settings.default_escalation_hours,
 *  finally to a hard-coded 24h. */
export function getEscalationHours(userId: number): number {
  const db = getDb();
  const u = db.prepare("SELECT escalation_hours FROM users WHERE id = ?")
    .get(userId) as { escalation_hours: number | null } | undefined;
  if (u && typeof u.escalation_hours === "number" && u.escalation_hours > 0) {
    return u.escalation_hours;
  }
  const sys = db.prepare(
    "SELECT default_escalation_hours FROM system_settings WHERE id = 1"
  ).get() as { default_escalation_hours: number | null } | undefined;
  if (sys && typeof sys.default_escalation_hours === "number" && sys.default_escalation_hours > 0) {
    return sys.default_escalation_hours;
  }
  return 24;
}

/** Append an entry to the JSON approval_history blob. Safe against
 *  malformed / empty existing blobs — treats them as []. */
export function appendApprovalHistory(
  existing: string | null,
  entry: ApprovalHistoryEntry
): string {
  let arr: ApprovalHistoryEntry[] = [];
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (Array.isArray(parsed)) arr = parsed;
    } catch { /* fall through to empty */ }
  }
  arr.push(entry);
  return JSON.stringify(arr);
}

/** Sweep one approval-bearing table and escalate any pending row
 *  whose current_approver hasn't decided within their escalation
 *  window. Returns counts so cron can log a summary.
 *
 *  Operates on { leave_requests | resignation_requests }. The
 *  column layout is identical thanks to the matching migrations
 *  in db.ts. */
export function escalateStaleRequests(
  table: "leave_requests" | "resignation_requests"
): { reassigned: number; topped_out: number } {
  const db = getDb();
  const nowMs = Date.now();
  const rows = db.prepare(`
    SELECT id, current_approver_user_id, escalated_to_level,
           last_escalated_at, created_at, approval_history
    FROM ${table}
    WHERE status = 'pending'
      AND current_approver_user_id IS NOT NULL
  `).all() as Array<{
    id: number;
    current_approver_user_id: number;
    escalated_to_level: number;
    last_escalated_at: string | null;
    created_at: string;
    approval_history: string | null;
  }>;

  let reassigned = 0;
  let toppedOut = 0;
  for (const r of rows) {
    const ageMs = nowMs - new Date(r.last_escalated_at ?? r.created_at).getTime();
    const hours = getEscalationHours(r.current_approver_user_id);
    if (ageMs < hours * 3_600_000) continue;
    const next = escalateOneStep(r.current_approver_user_id, r.escalated_to_level);
    if (!next) {
      toppedOut += 1;
      continue;
    }
    const nowIso = new Date().toISOString();
    const nextHistory = appendApprovalHistory(r.approval_history, {
      user_id: next.approver_user_id,
      level: next.level,
      assigned_at: nowIso,
      escalated_from: r.current_approver_user_id
    });
    db.prepare(`
      UPDATE ${table}
      SET current_approver_user_id = ?,
          escalated_to_level = ?,
          last_escalated_at = ?,
          approval_history = ?
      WHERE id = ?
    `).run(next.approver_user_id, next.level, nowIso, nextHistory, r.id);
    reassigned += 1;
  }
  return { reassigned, topped_out: toppedOut };
}

/** Helper for the request-creation path. Builds the four fields the
 *  caller should INSERT alongside the rest of the row data:
 *  current_approver_user_id, escalated_to_level, last_escalated_at,
 *  approval_history. */
export function buildInitialApprovalFields(
  requesterUserId: number
): {
  current_approver_user_id: number;
  escalated_to_level: number;
  last_escalated_at: string;
  approval_history: string;
} {
  const assignment = pickInitialApprover(requesterUserId);
  const nowIso = new Date().toISOString();
  return {
    current_approver_user_id: assignment.approver_user_id,
    escalated_to_level: 0,
    last_escalated_at: nowIso,
    approval_history: JSON.stringify([{
      user_id: assignment.approver_user_id,
      level: 0,
      assigned_at: nowIso
    } satisfies ApprovalHistoryEntry])
  };
}

/** True when the given user is the active approver on the given
 *  request — used to gate the approve/reject buttons in the UI and
 *  the corresponding API endpoint. Super_admin can ALWAYS act
 *  regardless of where the request currently sits — they're the
 *  ultimate authority. */
export function canActOnRequest(
  user: Pick<User, "id" | "role">,
  currentApproverUserId: number | null
): boolean {
  if (user.role === "super_admin") return true;
  return currentApproverUserId === user.id;
}
