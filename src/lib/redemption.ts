// Redemption (free-ice-cream-for-first-time) helpers.
//
// Two callers create rows: bookings (via POST /api/bookings and the
// admin variant) and walk_in_visits (via /staff/walk-in form). Both
// need to ask the same question: "is this customer first-time?".
// First-time = phone number not seen in either table before the new
// row's own timestamp.
//
// We deliberately ignore name + LINE userId for the match — phone is
// the most stable identifier (Thai customers rarely change numbers,
// and they reuse the same number across phone-in / walk-in / online).
// A null or empty phone is treated as NOT first-time, since we can't
// verify anything.

import { getDb } from "./db";
import { issueUniqueCode } from "./verification-code";

/** Has this phone number appeared on any prior booking or walk-in?
 *  `excludeBookingId` lets you skip the row you just created when
 *  checking from a webhook (so a brand-new booking doesn't disqualify
 *  itself).
 *
 *  IMPORTANT: stored customer_phone values are NOT normalised on
 *  insert (legacy + admin-entered rows may contain dashes, spaces,
 *  parens). We therefore normalise BOTH sides of the comparison via
 *  SQL REPLACE so "081-234-5678" in the DB matches "0812345678" from
 *  the new submission. Without this, every check returned false and
 *  every customer was wrongly marked first-time. */
export function hasPriorVisit(
  phone: string | null | undefined,
  opts: { excludeBookingId?: number; excludeWalkInId?: number } = {}
): boolean {
  const normalised = normalisePhone(phone);
  if (!normalised) return true;  // unknown → safer to assume returning
  const db = getDb();
  const exB = opts.excludeBookingId ?? 0;
  const exW = opts.excludeWalkInId ?? 0;
  // Strip whitespace, dashes, parens from the stored value at query
  // time. SQLite doesn't have a regex REPLACE, so we chain four
  // REPLACE calls — covers the formats Thai customers actually type.
  const NORM = `REPLACE(REPLACE(REPLACE(REPLACE(%s, ' ', ''), '-', ''), '(', ''), ')', '')`;
  const row = db.prepare(`
    SELECT 1 FROM bookings
      WHERE ${NORM.replace("%s", "customer_phone")} = ? AND id != ?
    UNION ALL
    SELECT 1 FROM walk_in_visits
      WHERE ${NORM.replace("%s", "phone")} = ? AND id != ?
    LIMIT 1
  `).get(normalised, exB, normalised, exW);
  return !!row;
}

/** Strip spaces / dashes / parentheses from a phone. Returns null
 *  if nothing usable remains. */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[\s\-()]/g, "").trim();
  return cleaned.length >= 6 ? cleaned : null;
}

/** Pick the redemption_status to stamp on a newly-created row.
 *  Returns { status, code } — code is only set when status === 'eligible'
 *  (no point burning code-space on a returning customer). */
export function assignRedemptionForNewRow(opts: {
  phone: string | null | undefined;
  excludeBookingId?: number;
  excludeWalkInId?: number;
}): { status: "eligible" | "not_eligible"; code: string | null } {
  const returning = hasPriorVisit(opts.phone, {
    excludeBookingId: opts.excludeBookingId,
    excludeWalkInId: opts.excludeWalkInId
  });
  if (returning) return { status: "not_eligible", code: null };
  return { status: "eligible", code: issueUniqueCode() };
}

/** Sweep both bookings + walk_in_visits and mark any still-eligible
 *  rows older than 6 hours past their booking_time / visited_at as
 *  'expired'. Returns counts so the caller can log. Called from the
 *  cron POST handler. Idempotent — re-running is cheap (WHERE clause
 *  filters out rows already flipped). */
export function expireOldRedemptions(): {
  bookings: number; walkIns: number;
} {
  const db = getDb();
  // Cutoff = now - 6h, expressed in the same shape as booking_time
  // ('YYYY-MM-DD HH:MM' built via the +07:00 Bangkok offset). We use
  // datetime() arithmetic in SQLite so the comparison is timezone-safe.
  const cutoffMs = Date.now() - 6 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();          // for walk_in_visits.visited_at
  const cutoffBkk = new Date(cutoffMs + 7 * 60 * 60 * 1000)    // for bookings (date + time strings in Bangkok)
    .toISOString().replace("T", " ").slice(0, 16);

  const bRes = db.prepare(`
    UPDATE bookings
    SET redemption_status = 'expired'
    WHERE redemption_status = 'eligible'
      AND (booking_date || ' ' || booking_time) <= ?
  `).run(cutoffBkk);
  const wRes = db.prepare(`
    UPDATE walk_in_visits
    SET redemption_status = 'expired'
    WHERE redemption_status = 'eligible'
      AND visited_at <= ?
  `).run(cutoffIso);

  return {
    bookings: typeof bRes.changes === "number" ? bRes.changes : 0,
    walkIns: typeof wRes.changes === "number" ? wRes.changes : 0
  };
}
