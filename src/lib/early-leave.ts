import type Database from "better-sqlite3";
import { getDb } from "./db";

type DbHandle = Database.Database;

// Early-leave approval (owner 2026-07-30). A staffer who redeemed the free lunch
// coupon but must leave the ≥8h shift early asks permission FIRST. A supervisor
// approves; an approved row for the day exempts them from the food-credit SVC
// clawback. Mirrors ot_requests: one row per (user, day), re-submit → pending.

export type EarlyLeaveStatus = "pending" | "approved" | "rejected";

/** Staff files (or refreshes) an early-leave request for a day → pending. */
export function requestEarlyLeave(
  userId: number, branchId: number | null, workDate: string, reason: string | null
): void {
  getDb().prepare(`
    INSERT INTO early_leave_requests (user_id, branch_id, work_date, reason, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
    ON CONFLICT (user_id, work_date) DO UPDATE SET
      reason = excluded.reason,
      branch_id = excluded.branch_id,
      status = 'pending',
      decided_by = NULL,
      decided_at = NULL
  `).run(userId, branchId, workDate, reason, new Date().toISOString());
}

/** Admin approves/rejects a staffer's early-leave for a day. Upserts so an admin
 *  can decide even before the staff filed (pre-approval). */
export function decideEarlyLeave(
  userId: number, branchId: number | null, workDate: string,
  decision: "approved" | "rejected", deciderId: number
): void {
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO early_leave_requests (user_id, branch_id, work_date, status, decided_by, decided_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, work_date) DO UPDATE SET
      status = excluded.status,
      branch_id = COALESCE(early_leave_requests.branch_id, excluded.branch_id),
      decided_by = excluded.decided_by,
      decided_at = excluded.decided_at
  `).run(userId, branchId, workDate, decision, deciderId, now, now);
}

/** True when the staffer has an APPROVED early-leave for the day — the exemption
 *  the SVC clawback checks. */
export function hasApprovedEarlyLeave(db: DbHandle, userId: number, workDate: string): boolean {
  const r = db.prepare(
    "SELECT 1 FROM early_leave_requests WHERE user_id = ? AND work_date = ? AND status = 'approved' LIMIT 1"
  ).get(userId, workDate);
  return !!r;
}

/** Set of "userId:date" approved early-leaves overlapping a calendar month — the
 *  clawback pass reads this once per branch/month (db-injectable for tests). */
export function approvedEarlyLeaveKeys(db: DbHandle, yearMonth: string): Set<string> {
  const rows = db.prepare(
    "SELECT user_id, work_date FROM early_leave_requests WHERE status = 'approved' AND substr(work_date, 1, 7) = ?"
  ).all(yearMonth) as Array<{ user_id: number; work_date: string }>;
  return new Set(rows.map((r) => `${r.user_id}:${r.work_date}`));
}

export type PendingEarlyLeave = {
  id: number; user_id: number; work_date: string; reason: string | null;
  name: string; created_at: string;
};

/** Pending early-leave requests for an admin's branch (for the decide UI). */
export function listPendingEarlyLeave(branchId: number): PendingEarlyLeave[] {
  return getDb().prepare(`
    SELECT e.id, e.user_id, e.work_date, e.reason, e.created_at,
           COALESCE(u.nickname_th, u.display_name) AS name
      FROM early_leave_requests e
      JOIN users u ON u.id = e.user_id
     WHERE e.status = 'pending' AND e.branch_id = ?
     ORDER BY e.work_date DESC, name COLLATE NOCASE
  `).all(branchId) as PendingEarlyLeave[];
}
