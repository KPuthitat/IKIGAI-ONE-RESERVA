// Disciplinary warning helpers (TC-P §8).
//
// Admin issues a warning → row inserted → LINE notification sent →
// staff opens the staff page → view row appended → staff PIN-confirms
// or leaves the page → either explicit or auto acknowledgment lands
// in disciplinary_warnings.acknowledged_at.
//
// Numbering scheme: D + YYYYMM + 2-digit running sequence per month.
// Same pattern as L (leave) and R (resignation) ref_no.

import { getDb } from "./db";
import type { DisciplinaryWarning } from "./db";

export function generateWarningRef(): string {
  const db = getDb();
  const nowBkk = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const ym = nowBkk.toISOString().slice(0, 7).replace("-", "");
  const prefix = `D${ym}`;
  const lastRow = db.prepare(
    "SELECT ref_no FROM disciplinary_warnings WHERE ref_no LIKE ? ORDER BY id DESC LIMIT 1"
  ).get(`${prefix}%`) as { ref_no: string } | undefined;
  let next = 1;
  if (lastRow?.ref_no) {
    const tail = lastRow.ref_no.slice(prefix.length);
    const n = Number(tail);
    if (Number.isInteger(n)) next = n + 1;
  }
  return `${prefix}${String(next).padStart(2, "0")}`;
}

export type WarningWithUsers = DisciplinaryWarning & {
  user_display_name: string;
  user_username: string;
  issued_by_name: string;
};

export function listWarningsForBranch(branchId: number, status: "all" | "pending" | "acknowledged" = "all"): WarningWithUsers[] {
  let extraWhere = "";
  if (status === "pending") extraWhere = " AND w.acknowledged_at IS NULL";
  if (status === "acknowledged") extraWhere = " AND w.acknowledged_at IS NOT NULL";
  return getDb().prepare(`
    SELECT w.*,
           u.display_name AS user_display_name,
           u.username AS user_username,
           iu.display_name AS issued_by_name
    FROM disciplinary_warnings w
    JOIN users u ON u.id = w.user_id
    JOIN users iu ON iu.id = w.issued_by_user_id
    WHERE w.branch_id = ?${extraWhere}
    ORDER BY w.issued_at DESC
    LIMIT 200
  `).all(branchId) as WarningWithUsers[];
}

export function listWarningsForUser(userId: number, status: "all" | "pending" | "acknowledged" = "all"): WarningWithUsers[] {
  let extraWhere = "";
  if (status === "pending") extraWhere = " AND w.acknowledged_at IS NULL";
  if (status === "acknowledged") extraWhere = " AND w.acknowledged_at IS NOT NULL";
  return getDb().prepare(`
    SELECT w.*,
           u.display_name AS user_display_name,
           u.username AS user_username,
           iu.display_name AS issued_by_name
    FROM disciplinary_warnings w
    JOIN users u ON u.id = w.user_id
    JOIN users iu ON iu.id = w.issued_by_user_id
    WHERE w.user_id = ?${extraWhere}
    ORDER BY w.issued_at DESC
  `).all(userId) as WarningWithUsers[];
}

export function getWarning(id: number): WarningWithUsers | null {
  return (getDb().prepare(`
    SELECT w.*,
           u.display_name AS user_display_name,
           u.username AS user_username,
           iu.display_name AS issued_by_name
    FROM disciplinary_warnings w
    JOIN users u ON u.id = w.user_id
    JOIN users iu ON iu.id = w.issued_by_user_id
    WHERE w.id = ?
  `).get(id) as WarningWithUsers | undefined) ?? null;
}

/** Append a row in disciplinary_warning_views every time the staff
 *  opens the warning. Multiple views per warning are fine — the
 *  audit trail proves they saw it more than once. */
export function recordView(warningId: number, ip?: string | null, userAgent?: string | null): void {
  getDb().prepare(`
    INSERT INTO disciplinary_warning_views (warning_id, ip, user_agent)
    VALUES (?, ?, ?)
  `).run(warningId, ip ?? null, userAgent ?? null);
}

export function acknowledgeWarning(
  id: number,
  method: "pin_explicit" | "auto_on_leave",
  reason?: string | null
): boolean {
  const db = getDb();
  // Only first acknowledgment wins. Avoid overwriting an explicit
  // acknowledgement with a later auto one (e.g. staff already clicked,
  // then beforeunload fires a stale auto-ack racing in behind it).
  const r = db.prepare(`
    UPDATE disciplinary_warnings
    SET acknowledged_at = CURRENT_TIMESTAMP,
        acknowledged_method = ?,
        auto_ack_reason = ?
    WHERE id = ? AND acknowledged_at IS NULL
  `).run(method, reason ?? null, id);
  return r.changes > 0;
}
