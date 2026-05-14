// Account invites (TC-A Phase 2).
//
// Three kinds:
//   onboard      — admin creates a new user row + invite. Recipient
//                  redeems by setting username/password/PIN.
//   reset        — staff lost their PIN/password; admin re-issues an
//                  invite that lets them set new ones (kept their
//                  user_id + display_name etc.).
//   rebind_line  — staff changed LINE accounts. Re-uses the same flow
//                  to capture the new LIFF userId on redemption.
//
// Tokens are 32 random URL-safe chars (~190 bits of entropy).
// Single-use: setting used_at locks the invite. 7-day TTL by default.

import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { getDb } from "./db";
import type { Invite, InviteKind } from "./db";

export const INVITE_TTL_DAYS = 7;
export const EMERGENCY_TTL_HOURS = 24;

/** Generate a URL-safe random token. We slice 32 chars from a 48-byte
 *  base64url so the alphabet excludes `+ /` and we still have plenty
 *  of entropy left. */
export function generateToken(): string {
  return crypto.randomBytes(48).toString("base64url").slice(0, 32);
}

export function createInvite(args: {
  userId: number;
  kind: InviteKind;
  createdBy: number;
  ttlDays?: number;
}): Invite {
  const db = getDb();
  const ttl = args.ttlDays ?? INVITE_TTL_DAYS;
  const token = generateToken();
  const expiresAt = new Date(Date.now() + ttl * 86400_000).toISOString();
  const info = db.prepare(`
    INSERT INTO invites (user_id, token, expires_at, created_by, kind)
    VALUES (?, ?, ?, ?, ?)
  `).run(args.userId, token, expiresAt, args.createdBy, args.kind);
  return {
    id: Number(info.lastInsertRowid),
    user_id: args.userId,
    token,
    expires_at: expiresAt,
    used_at: null,
    created_by: args.createdBy,
    created_at: new Date().toISOString(),
    kind: args.kind
  };
}

export type InviteWithUser = Invite & {
  user_display_name: string;
  user_status: string;
};

/** Look up an invite by token. Returns null when the token doesn't
 *  exist, is already used, or has expired. */
export function lookupValidInvite(token: string): InviteWithUser | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT i.*, u.display_name AS user_display_name, u.status AS user_status
    FROM invites i JOIN users u ON u.id = i.user_id
    WHERE i.token = ?
  `).get(token) as InviteWithUser | undefined;
  if (!row) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

/** Mark an invite consumed. Idempotent — callers can re-call without
 *  worrying about race conditions, but ONLY the first call returns
 *  true. */
export function consumeInvite(inviteId: number): boolean {
  const nowIso = new Date().toISOString();
  const r = getDb().prepare(`
    UPDATE invites SET used_at = ?
    WHERE id = ? AND used_at IS NULL
  `).run(nowIso, inviteId);
  return r.changes > 0;
}

/** Redeem an onboard/reset invite: set username + password + PIN on
 *  the linked user row, flip status to 'active', and mark the invite
 *  used. Returns the user id on success or null when the invite is
 *  invalid. Throws when the username collides with another row.
 *
 *  For rebind_line invites we DON'T touch credentials — only the
 *  LINE userId binding (caller passes that separately via
 *  setLineUserId below). */
export function redeemInvite(args: {
  token: string;
  username: string;
  password: string;
  pin: string;
  lineUserId?: string | null;
}): { userId: number; kind: InviteKind } | null {
  const invite = lookupValidInvite(args.token);
  if (!invite) return null;
  const db = getDb();
  const passwordHash = bcrypt.hashSync(args.password, 10);
  const pinHash = bcrypt.hashSync(args.pin, 10);
  // Atomic: take the invite + update the user in one transaction so
  // a crash partway can't leave the invite consumed but the user
  // half-credentialed.
  const tx = db.transaction(() => {
    if (!consumeInvite(invite.id)) return false;
    if (invite.kind === "rebind_line") {
      // Only update LINE binding + status; keep existing credentials.
      db.prepare(`
        UPDATE users SET line_user_id = ?, status = 'active'
        WHERE id = ?
      `).run(args.lineUserId ?? null, invite.user_id);
    } else {
      db.prepare(`
        UPDATE users
        SET username = ?, password_hash = ?, pin_hash = ?,
            line_user_id = COALESCE(?, line_user_id),
            status = 'active'
        WHERE id = ?
      `).run(args.username, passwordHash, pinHash,
             args.lineUserId ?? null, invite.user_id);
    }
    return true;
  });
  const ok = tx();
  if (!ok) return null;
  return { userId: invite.user_id, kind: invite.kind };
}

export function listInvitesForUser(userId: number): Invite[] {
  return getDb().prepare(`
    SELECT * FROM invites WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId) as Invite[];
}

export function revokeOpenInvites(userId: number, reason?: string): number {
  // Mark all unused invites for the user as used. Used when admin
  // re-issues — old links should die so the staff doesn't have two
  // valid ones at once.
  const nowIso = new Date().toISOString();
  const r = getDb().prepare(`
    UPDATE invites SET used_at = ?
    WHERE user_id = ? AND used_at IS NULL
  `).run(nowIso, userId);
  return r.changes;
}
