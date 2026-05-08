// Multi-channel LINE OA storage.
//
// IKIGAI ONE has more than one LINE OA in play:
//   - "IKIGAI OS" (scope=platform): used by PERSONA + ASCENDA — staff-facing
//     notifications such as the clock-in confirmation card. Single OA shared
//     across all restaurants.
//   - Per-branch RESERVA OAs (scope=reserva): customer-facing booking
//     notifications. Today these are still read from branches.line_channel_*
//     for backward compat; the messaging_channels table will absorb them as
//     /admin/reserva/settings is migrated.
//
// All rows live in messaging_channels (see db.ts). Lookups by `code`. The
// platform OA is seeded with code='ikigai-os' on first DB open.

import { getDb } from "./db";

export type MessagingChannel = {
  id: number;
  scope: "platform" | "reserva";
  code: string;
  label: string;
  branch_id: number | null;
  channel_secret: string | null;
  channel_token: string | null;
  updated_at: string;
  updated_by: number | null;
};

const PLATFORM_CODE = "ikigai-os";

/** The IKIGAI OS platform channel (singleton). Returns null if not configured. */
export function getPlatformChannel(): MessagingChannel | null {
  const row = getDb().prepare(
    "SELECT * FROM messaging_channels WHERE code = ? LIMIT 1"
  ).get(PLATFORM_CODE) as MessagingChannel | undefined;
  return row ?? null;
}

/** Look up any channel by its webhook code/slug. Used by the webhook router. */
export function getChannelByCode(code: string): MessagingChannel | null {
  const row = getDb().prepare(
    "SELECT * FROM messaging_channels WHERE code = ? LIMIT 1"
  ).get(code) as MessagingChannel | undefined;
  return row ?? null;
}

/** All RESERVA per-branch channels, ordered by branch label. */
export function listReservaChannels(): MessagingChannel[] {
  return getDb().prepare(
    "SELECT * FROM messaging_channels WHERE scope = 'reserva' ORDER BY label"
  ).all() as MessagingChannel[];
}

/** Partial-update credentials on any channel by code (platform or reserva).
 *  Same three-state semantics as setPlatformChannel:
 *    undefined = leave alone, "" = clear, non-empty = set. */
export function setChannelCreds(args: {
  code: string;
  channel_token?: string | undefined;
  channel_secret?: string | undefined;
  updated_by: number | null;
}): { ok: true } | { ok: false; error: "not_found" } {
  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM messaging_channels WHERE code = ?").get(args.code);
  if (!exists) return { ok: false, error: "not_found" };

  const sets: string[] = [];
  const vals: Array<string | number | null> = [];

  if (args.channel_token !== undefined) {
    sets.push("channel_token = ?");
    const v = args.channel_token.trim();
    vals.push(v === "" ? null : v);
  }
  if (args.channel_secret !== undefined) {
    sets.push("channel_secret = ?");
    const v = args.channel_secret.trim();
    vals.push(v === "" ? null : v);
  }
  if (sets.length === 0) return { ok: true };

  sets.push("updated_at = CURRENT_TIMESTAMP");
  sets.push("updated_by = ?");
  vals.push(args.updated_by);
  vals.push(args.code);

  db.prepare(`UPDATE messaging_channels SET ${sets.join(", ")} WHERE code = ?`).run(...vals);
  return { ok: true };
}

/** True if a channel has both secret + token filled in (= ready to send). */
export function isChannelReady(c: MessagingChannel | null): boolean {
  return !!(c && c.channel_secret && c.channel_token);
}

/** Partial-update credentials on the IKIGAI OS platform channel.
 *
 * Each field follows three-state semantics:
 *   - `undefined`   → leave the existing value alone
 *   - empty string  → clear (NULL)
 *   - non-empty     → set / overwrite
 */
export function setPlatformChannel(args: {
  channel_token?: string | undefined;
  channel_secret?: string | undefined;
  updated_by: number | null;
}): void {
  const db = getDb();
  // Ensure the row exists (seed runs on first DB open, but safe-guard anyway)
  db.prepare(`
    INSERT OR IGNORE INTO messaging_channels (scope, code, label)
    VALUES ('platform', ?, 'IKIGAI OS')
  `).run(PLATFORM_CODE);

  const sets: string[] = [];
  const vals: Array<string | number | null> = [];

  if (args.channel_token !== undefined) {
    sets.push("channel_token = ?");
    const v = args.channel_token.trim();
    vals.push(v === "" ? null : v);
  }
  if (args.channel_secret !== undefined) {
    sets.push("channel_secret = ?");
    const v = args.channel_secret.trim();
    vals.push(v === "" ? null : v);
  }

  if (sets.length === 0) return;

  sets.push("updated_at = CURRENT_TIMESTAMP");
  sets.push("updated_by = ?");
  vals.push(args.updated_by);
  vals.push(PLATFORM_CODE);

  db.prepare(`UPDATE messaging_channels SET ${sets.join(", ")} WHERE code = ?`).run(...vals);
}
