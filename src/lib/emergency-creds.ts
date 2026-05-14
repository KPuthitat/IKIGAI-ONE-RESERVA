// Emergency credentials (TC-A Phase 2).
//
// 24-hour temporary username+password that admin issues for a staff
// who can't log in the normal way — phone dead, LINE bug, forgot
// password, etc. The login route checks these credentials when the
// regular `users.username + password_hash` match fails, so the staff
// gets in with the temp creds, then can reset their main credentials.
//
// Temp username is `<staff-username>.emrg<random4>` so it's obviously
// a one-shot. Temp password is 8 random URL-safe chars (admin reads
// it out / messages it to the staff via a side channel).

import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { getDb } from "./db";
import type { EmergencyCredential } from "./db";

export const EMERGENCY_TTL_HOURS = 24;

function shortToken(n = 4): string {
  return crypto.randomBytes(8).toString("base64url").replace(/[_-]/g, "").slice(0, n);
}

function tempPassword(): string {
  return crypto.randomBytes(8).toString("base64url").replace(/[_-]/g, "").slice(0, 10);
}

/** Issue a fresh emergency cred. Returns the plaintext password
 *  exactly once — admin must communicate it to the staff. */
export function issueEmergencyCred(args: {
  userId: number;
  createdBy: number;
  ttlHours?: number;
}): { id: number; temp_username: string; temp_password: string; expires_at: string } {
  const db = getDb();
  // Revoke any active emergency creds for the same user — the admin
  // is presumably re-issuing because the previous one was lost.
  db.prepare(`
    UPDATE emergency_credentials
    SET revoked_at = CURRENT_TIMESTAMP, revoke_reason = 'superseded'
    WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL
      AND expires_at > CURRENT_TIMESTAMP
  `).run(args.userId);

  const ttl = args.ttlHours ?? EMERGENCY_TTL_HOURS;
  const expiresAt = new Date(Date.now() + ttl * 3600_000).toISOString();
  // Build a recognisable username — base it on the user's real
  // username so the staff can identify what they're typing.
  const baseUser = db.prepare("SELECT username FROM users WHERE id = ?")
    .get(args.userId) as { username: string } | undefined;
  const tempUsername = `${baseUser?.username ?? "user"}.emrg${shortToken()}`;
  const pwd = tempPassword();
  const info = db.prepare(`
    INSERT INTO emergency_credentials
      (user_id, temp_username, temp_password_hash, expires_at, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(args.userId, tempUsername, bcrypt.hashSync(pwd, 10), expiresAt, args.createdBy);
  return {
    id: Number(info.lastInsertRowid),
    temp_username: tempUsername,
    temp_password: pwd,
    expires_at: expiresAt
  };
}

/** Try to log in with emergency credentials. Returns the underlying
 *  user_id when valid, or null. Marks the row used (single-shot) so
 *  the temp creds can't be replayed by anyone who happens to see
 *  them in chat history. */
export function consumeEmergencyCred(
  username: string, password: string
): number | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM emergency_credentials
    WHERE temp_username = ? AND used_at IS NULL AND revoked_at IS NULL
      AND expires_at > CURRENT_TIMESTAMP
  `).get(username) as EmergencyCredential | undefined;
  if (!row) return null;
  if (!bcrypt.compareSync(password, row.temp_password_hash)) return null;
  db.prepare("UPDATE emergency_credentials SET used_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(row.id);
  return row.user_id;
}

export function listEmergencyCredsForUser(userId: number): EmergencyCredential[] {
  return getDb().prepare(`
    SELECT * FROM emergency_credentials
    WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(userId) as EmergencyCredential[];
}
