// Admin PIN — short-secret (4-6 digits) verification used to gate
// high-trust admin actions like RECRUITA stage transitions. Separate
// concept from the account password:
//   - Password proves "this is my account" at login.
//   - PIN proves "I'm physically present at the screen right now",
//     re-verified at each gated action.
//
// Why a separate factor? Once an admin is logged in, anyone with
// access to that browser session can change candidate stages.
// Requiring a short PIN at the action level forces a fresh
// confirmation without making them re-enter the full password.
//
// Pairs with the recruita_stage_change_requests table: every stage
// transition needs TWO different admins, each verifying their PIN.

import bcrypt from "bcryptjs";
import { getDb } from "./db";

/** Brute-force resistance for a 6-digit PIN: 5 wrong tries → lock
 *  for the LOCKOUT_MINUTES window. Reset on a successful verify. */
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

export type PinStatus =
  | { ok: true }
  | { ok: false; reason: "no_pin" | "locked" | "wrong_pin" | "user_not_found" };

/** Set or change a user's PIN. Caller must already have verified the
 *  user's identity (current password or super-admin reset path).
 *  Returns false when the PIN doesn't match the 4-6 digit format. */
export function setAdminPin(userId: number, newPin: string): boolean {
  if (!/^\d{4,6}$/.test(newPin)) return false;
  const hash = bcrypt.hashSync(newPin, 8);
  const db = getDb();
  db.prepare(`
    UPDATE users
       SET admin_pin_hash = ?,
           admin_pin_set_at = CURRENT_TIMESTAMP,
           admin_pin_failed_attempts = 0,
           admin_pin_locked_until = NULL
     WHERE id = ?
  `).run(hash, userId);
  return true;
}

/** True iff a PIN is currently configured for this user. Used by the
 *  UI to render "Set up your PIN" prompts before they hit a gated
 *  action. */
export function hasAdminPin(userId: number): boolean {
  const row = getDb().prepare(
    "SELECT admin_pin_hash FROM users WHERE id = ?"
  ).get(userId) as { admin_pin_hash: string | null } | undefined;
  return !!row?.admin_pin_hash;
}

/** Verify a PIN attempt. On success, resets failed counter. On
 *  failure, increments the counter + locks for 15 minutes when it
 *  reaches MAX_FAILED_ATTEMPTS. Returns a discriminated result so
 *  the UI can render specific messages ("PIN ผิด" vs "ล็อก 15 นาที"). */
export function verifyAdminPin(userId: number, pin: string): PinStatus {
  const db = getDb();
  const row = db.prepare(`
    SELECT admin_pin_hash, admin_pin_failed_attempts, admin_pin_locked_until
    FROM users WHERE id = ?
  `).get(userId) as {
    admin_pin_hash: string | null;
    admin_pin_failed_attempts: number;
    admin_pin_locked_until: string | null;
  } | undefined;
  if (!row) return { ok: false, reason: "user_not_found" };
  if (!row.admin_pin_hash) return { ok: false, reason: "no_pin" };

  // Hard lock check — lockout_until in the future = still locked.
  if (row.admin_pin_locked_until) {
    const until = new Date(row.admin_pin_locked_until).getTime();
    if (until > Date.now()) {
      return { ok: false, reason: "locked" };
    }
  }

  const match = bcrypt.compareSync(pin, row.admin_pin_hash);
  if (match) {
    // Success — clear the counter so a string of bad guesses
    // followed by a correct one doesn't lock the user out next time.
    db.prepare(`
      UPDATE users
         SET admin_pin_failed_attempts = 0,
             admin_pin_locked_until = NULL
       WHERE id = ?
    `).run(userId);
    return { ok: true };
  }

  // Failure — bump counter. When it hits MAX_FAILED_ATTEMPTS we set
  // lockout_until 15 minutes ahead. Counter keeps incrementing past
  // the cap so a determined attacker doesn't get unlimited tries
  // every 15 min — but the lock auto-expires for legit admins.
  const newCount = row.admin_pin_failed_attempts + 1;
  if (newCount >= MAX_FAILED_ATTEMPTS) {
    const until = new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString();
    db.prepare(`
      UPDATE users
         SET admin_pin_failed_attempts = ?,
             admin_pin_locked_until = ?
       WHERE id = ?
    `).run(newCount, until, userId);
    return { ok: false, reason: "locked" };
  }
  db.prepare(
    "UPDATE users SET admin_pin_failed_attempts = ? WHERE id = ?"
  ).run(newCount, userId);
  return { ok: false, reason: "wrong_pin" };
}
