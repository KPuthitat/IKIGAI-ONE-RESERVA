// Impersonation (TC-A Phase 2).
//
// Super_admin (and admin, for staff in their branch) can "log in as"
// another user to debug/inspect what that user sees. Implementation:
//
//   1. /api/admin/impersonate/[targetId] POST starts the session.
//      We write an impersonation_log row + set a marker cookie
//      reserva_impersonator=<row_id> on the response. We ALSO swap
//      the session's user_id to the target so all downstream auth
//      reads see the target. The marker cookie lets us:
//        a) render the orange "You are viewing as <name>" banner
//        b) restore the impersonator's session on /stop
//
//   2. /api/admin/impersonate/end POST closes it. We look up the
//      open log row, set ended_at, restore the session's user_id
//      to impersonator_id, and clear the marker cookie.
//
// The log table is the source of truth — never deleted, so "who did
// what" can always distinguish a real action by user X from an
// impersonated session driven by admin Y.

import { getDb } from "./db";
import { cookies } from "next/headers";

const COOKIE = "reserva_impersonator";

export function isImpersonating(): boolean {
  return !!cookies().get(COOKIE)?.value;
}

export function impersonatorLogId(): number | null {
  const v = cookies().get(COOKIE)?.value;
  if (!v) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Start an impersonation session. Returns the new log row id and
 *  also flips the session's user_id to the target. Caller (the API
 *  route) sets the marker cookie and responds. */
export function startImpersonation(args: {
  sessionId: string;
  impersonatorId: number;
  targetUserId: number;
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}): number {
  const db = getDb();
  const r = db.prepare(`
    INSERT INTO impersonation_log
      (impersonator_id, target_user_id, reason, ip, user_agent)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    args.impersonatorId, args.targetUserId,
    args.reason ?? null, args.ip ?? null, args.userAgent ?? null
  );
  db.prepare("UPDATE sessions SET user_id = ? WHERE id = ?")
    .run(args.targetUserId, args.sessionId);
  return Number(r.lastInsertRowid);
}

/** End an impersonation session. Restores the session to the
 *  impersonator and stamps ended_at. */
export function endImpersonation(args: {
  sessionId: string;
  logId: number;
}): boolean {
  const db = getDb();
  const row = db.prepare(
    "SELECT impersonator_id, ended_at FROM impersonation_log WHERE id = ?"
  ).get(args.logId) as { impersonator_id: number; ended_at: string | null } | undefined;
  if (!row || row.ended_at) return false;
  db.prepare("UPDATE sessions SET user_id = ? WHERE id = ?")
    .run(row.impersonator_id, args.sessionId);
  db.prepare(
    "UPDATE impersonation_log SET ended_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(args.logId);
  return true;
}

/** Server-side helper for the banner — reads the log row pointed at
 *  by the cookie + joins both user names. Returns null when not
 *  impersonating. */
export function currentImpersonationContext(): {
  logId: number;
  impersonatorId: number;
  impersonatorName: string;
  targetId: number;
  targetName: string;
  startedAt: string;
} | null {
  const id = impersonatorLogId();
  if (!id) return null;
  const row = getDb().prepare(`
    SELECT l.id AS log_id, l.impersonator_id, l.target_user_id, l.started_at,
           ui.display_name AS impersonator_name,
           ut.display_name AS target_name,
           l.ended_at
    FROM impersonation_log l
    JOIN users ui ON ui.id = l.impersonator_id
    JOIN users ut ON ut.id = l.target_user_id
    WHERE l.id = ?
  `).get(id) as {
    log_id: number; impersonator_id: number; target_user_id: number; started_at: string;
    impersonator_name: string; target_name: string; ended_at: string | null;
  } | undefined;
  if (!row || row.ended_at) return null;
  return {
    logId: row.log_id,
    impersonatorId: row.impersonator_id,
    impersonatorName: row.impersonator_name,
    targetId: row.target_user_id,
    targetName: row.target_name,
    startedAt: row.started_at
  };
}

export const IMPERSONATOR_COOKIE = COOKIE;
