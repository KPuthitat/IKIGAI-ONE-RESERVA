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
  user_title_prefix: string | null;
  user_username: string;
  issued_by_name: string;
  issued_by_prefix: string | null;
};

export function listWarningsForBranch(branchId: number, status: "all" | "pending" | "acknowledged" = "all"): WarningWithUsers[] {
  let extraWhere = "";
  if (status === "pending") extraWhere = " AND w.acknowledged_at IS NULL";
  if (status === "acknowledged") extraWhere = " AND w.acknowledged_at IS NOT NULL";
  return getDb().prepare(`
    SELECT w.*,
           u.display_name AS user_display_name,
           u.title_prefix AS user_title_prefix,
           u.username AS user_username,
           iu.display_name AS issued_by_name,
           iu.title_prefix AS issued_by_prefix
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
           u.title_prefix AS user_title_prefix,
           u.username AS user_username,
           iu.display_name AS issued_by_name,
           iu.title_prefix AS issued_by_prefix
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
           u.title_prefix AS user_title_prefix,
           u.username AS user_username,
           iu.display_name AS issued_by_name,
           iu.title_prefix AS issued_by_prefix
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

// Severity escalation order — used by getSuggestedSeverity() to bump
// up one step when a previous warning is still within its validity
// window. Final stays final (next step would be terminate, which is
// outside this system's scope — admin decides separately).
const SEVERITY_LADDER = ["verbal", "written_1", "written_2", "final"] as const;
export type WarningSeverity = (typeof SEVERITY_LADDER)[number];

/** Return the active (non-expired, ignoring acknowledged status)
 *  warnings for a user. Active = issued within their validity window.
 *  validity_months NULL → treated as no-expiry → always active until
 *  admin manually closes (legacy behavior pre-2026-05-22). */
export function listActiveWarnings(userId: number): WarningWithUsers[] {
  const rows = listWarningsForUser(userId);
  const nowMs = Date.now();
  return rows.filter((w) => {
    if (!w.validity_months) return true;  // null = no expiry
    const issuedMs = new Date(w.issued_at + (w.issued_at.endsWith("Z") ? "" : "Z")).getTime();
    const expiresMs = issuedMs + w.validity_months * 30 * 86400_000;
    return nowMs < expiresMs;
  });
}

/** Suggest the next severity for a new warning given the user's
 *  current active history. Logic:
 *    - No active warnings → 'verbal' (start of ladder)
 *    - One+ active → bump highest one step (capped at 'final')
 *  Caller (admin form) shows this as a recommendation; admin can
 *  override before submitting. */
export function getSuggestedSeverity(userId: number): {
  suggested: WarningSeverity;
  highestActive: WarningSeverity | null;
  activeCount: number;
} {
  const active = listActiveWarnings(userId);
  if (active.length === 0) {
    return { suggested: "verbal", highestActive: null, activeCount: 0 };
  }
  // Find the highest severity among active warnings
  let highestIdx = -1;
  for (const w of active) {
    const idx = SEVERITY_LADDER.indexOf(w.severity as WarningSeverity);
    if (idx > highestIdx) highestIdx = idx;
  }
  const highestActive = SEVERITY_LADDER[highestIdx] ?? null;
  // Bump one step (or stay at final if already there).
  const nextIdx = Math.min(highestIdx + 1, SEVERITY_LADDER.length - 1);
  return {
    suggested: SEVERITY_LADDER[nextIdx],
    highestActive,
    activeCount: active.length
  };
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
