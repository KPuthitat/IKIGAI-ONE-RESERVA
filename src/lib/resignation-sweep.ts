// Resignation auto-close + 1-year purge.
//
// Two sweeps the cron runs daily:
//
//   sweepResignationsToTake(today)
//     Approved resignation whose proposed_last_day < today AND the
//     user is still 'active' → flip user to 'resigned', stamp
//     resigned_at, kill all their sessions so they can't keep using
//     a stale cookie. Idempotent — second call is a no-op because
//     users.status has already moved.
//
//   sweepResignationPurge(today)
//     Users with status='resigned' whose resigned_at is more than
//     RESIGNATION_RETENTION_DAYS old → DELETE the row entirely.
//     Cascades clean up sessions, leave_requests etc. via the
//     ON DELETE CASCADE foreign keys those tables already declare.
//
// Both sweeps return what they touched so the cron summary can log
// it (visible on the /admin diagnostic page + LINE OOM error reporter).

import { getDb } from "./db";

/** How long an auto-resigned user's data is retained before the
 *  purge sweep deletes them. Owner direction 2026-05-28: 1 year so
 *  payroll back-references stay valid for tax-year close. */
export const RESIGNATION_RETENTION_DAYS = 365;

export type SweepCloseResult = {
  /** Users transitioned from 'active' to 'resigned' this run. */
  closed: number;
  /** User ids affected — caller may DM each one a LINE card
   *  explaining the closure. */
  userIds: number[];
};

/** Date math without pulling in a date lib. Returns YYYY-MM-DD
 *  Bangkok-local for `today` minus N days. Used to pick the purge
 *  cutoff and inside sweepResignationsToTake's date comparison. */
function bkkDateMinusDays(todayBkk: string, days: number): string {
  const [y, m, d] = todayBkk.split("-").map(Number);
  // Construct in UTC then read back as date-only — DST doesn't apply
  // in Thailand so this is exact.
  const ms = Date.UTC(y, m - 1, d) - days * 86400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Cron-callable. Flip approved-resignation users to 'resigned'
 *  when their proposed_last_day has passed (i.e. yesterday or
 *  earlier in Bangkok time). Owner direction: lock the account
 *  on the day AFTER the staff's last working day. */
export function sweepResignationsToTake(todayBkk: string): SweepCloseResult {
  const db = getDb();
  // Find every user whose latest approved resignation has a
  // proposed_last_day strictly before today AND whose user row is
  // still 'active'. The ORDER BY + GROUP BY pattern picks the most
  // recent approved resignation per user — in case a user resigned
  // twice (rare, but possible after admin grants a re-hire then
  // they resign again).
  const candidates = db.prepare(`
    SELECT u.id AS user_id, u.display_name,
           MAX(r.proposed_last_day) AS last_day
    FROM users u
    JOIN resignation_requests r ON r.user_id = u.id
    WHERE u.status = 'active'
      AND r.status = 'approved'
    GROUP BY u.id
    HAVING last_day < ?
  `).all(todayBkk) as Array<{ user_id: number; display_name: string; last_day: string }>;

  if (candidates.length === 0) return { closed: 0, userIds: [] };

  const nowIso = new Date().toISOString();
  const closeUser = db.prepare(`
    UPDATE users
    SET status = 'resigned',
        resigned_at = ?
    WHERE id = ? AND status = 'active'
  `);
  // Kill active sessions so a still-logged-in user can't keep
  // hitting authenticated routes from a stale cookie. The session
  // table is FK-cascaded on users delete, but here the user row
  // stays for retention — we just zap the session rows directly.
  const killSessions = db.prepare("DELETE FROM sessions WHERE user_id = ?");

  const userIds: number[] = [];
  const tx = db.transaction(() => {
    for (const c of candidates) {
      const r = closeUser.run(nowIso, c.user_id);
      if (r.changes > 0) {
        killSessions.run(c.user_id);
        userIds.push(c.user_id);
      }
    }
  });
  tx();

  return { closed: userIds.length, userIds };
}

export type SweepPurgeResult = {
  /** Number of users.* rows fully deleted. Cascades carry away
   *  user_branches, sessions, leave_requests, etc. */
  purged: number;
  /** User ids deleted (for audit log / debugging). */
  userIds: number[];
};

/** Cron-callable. DELETE users.* rows whose status='resigned' AND
 *  resigned_at is older than RESIGNATION_RETENTION_DAYS. Cascades
 *  drop child rows automatically via the FK constraints declared on
 *  user_branches, sessions, leave_requests, etc. (most of those
 *  tables already have ON DELETE CASCADE — see schema.sql + the
 *  schema migrations).
 *
 *  Owner direction 2026-05-28: 1 year — covers a full tax-year
 *  close so payroll back-references stay valid for SSO + ภงด
 *  reconciliation. */
export function sweepResignationPurge(todayBkk: string): SweepPurgeResult {
  const db = getDb();
  const cutoffDate = bkkDateMinusDays(todayBkk, RESIGNATION_RETENTION_DAYS);
  // Compare resigned_at (ISO ts) against the cutoff date-string by
  // pulling the YYYY-MM-DD prefix of resigned_at. Lex-compare on
  // YYYY-MM-DD is total-ordered so this is safe.
  const candidates = db.prepare(`
    SELECT id FROM users
    WHERE status = 'resigned'
      AND resigned_at IS NOT NULL
      AND substr(resigned_at, 1, 10) < ?
  `).all(cutoffDate) as Array<{ id: number }>;

  if (candidates.length === 0) return { purged: 0, userIds: [] };

  const del = db.prepare("DELETE FROM users WHERE id = ?");
  const userIds: number[] = [];
  const tx = db.transaction(() => {
    for (const c of candidates) {
      const r = del.run(c.id);
      if (r.changes > 0) userIds.push(c.id);
    }
  });
  tx();

  return { purged: userIds.length, userIds };
}
