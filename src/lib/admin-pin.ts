// Admin PIN — proves "I'm physically present" for high-trust admin
// actions like RECRUITA stage approvals. Reuses users.pin_hash, the
// same 4-digit bcrypt hash staff set up when they redeem their
// onboard invite or hit the time-clock for the first time. Owner
// 2026-06-01 explicitly: "ทุกคนตอนสมัครบังคับสร้าง PIN อยู่แล้ว" —
// no separate admin PIN, no separate setup page.
//
// We INTENTIONALLY don't add brute-force lockout here:
//   - The same pin_hash also gates the time-clock /api/persona/clock
//     endpoint. Locking on N wrong stage-approval attempts would
//     also lock the user out of clocking in.
//   - 4 digits = 10,000 possibilities. Network-level rate limiting
//     (route handler) is the better defense — track per-IP, not
//     per-user.
//
// If a future requirement adds lockout, store it in a separate table
// keyed by (user_id, action_kind) so time-clock and admin actions
// can have independent counters.

import bcrypt from "bcryptjs";
import { getDb } from "./db";

export type PinStatus =
  | { ok: true }
  | { ok: false; reason: "no_pin" | "wrong_pin" | "user_not_found" };

/** True iff the user has a PIN configured (4-digit pin_hash set).
 *  Used by the UI to render "Set up your PIN" prompts before they
 *  hit a gated action. */
export function hasAdminPin(userId: number): boolean {
  const row = getDb().prepare(
    "SELECT pin_hash FROM users WHERE id = ?"
  ).get(userId) as { pin_hash: string | null } | undefined;
  return !!row?.pin_hash;
}

/** Verify a PIN attempt against users.pin_hash. The PIN format is
 *  4 digits exact — matches /^\d{4}$/ used by /api/persona/set-pin
 *  and the time-clock endpoint. Anything else returns wrong_pin
 *  rather than a validation error so the failure-mode at the API
 *  boundary stays uniform. */
export function verifyAdminPin(userId: number, pin: string): PinStatus {
  if (!/^\d{4}$/.test(pin)) return { ok: false, reason: "wrong_pin" };
  const row = getDb().prepare(
    "SELECT pin_hash FROM users WHERE id = ?"
  ).get(userId) as { pin_hash: string | null } | undefined;
  if (!row) return { ok: false, reason: "user_not_found" };
  if (!row.pin_hash) return { ok: false, reason: "no_pin" };
  if (!bcrypt.compareSync(pin, row.pin_hash)) {
    return { ok: false, reason: "wrong_pin" };
  }
  return { ok: true };
}
