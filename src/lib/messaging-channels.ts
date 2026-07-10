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
import { encryptSecret, decryptSecret } from "./secret-vault";

export type MessagingChannel = {
  id: number;
  scope: "platform" | "reserva" | "recruita" | "delivera";
  code: string;
  label: string;
  branch_id: number | null;
  channel_secret: string | null;     // plaintext after decryptRow (DB stores "enc:v1:" blob)
  channel_token: string | null;      // plaintext after decryptRow
  liff_id: string | null;            // LIFF app ID for the apply page (RECRUITA) or booking page (RESERVA)
  liff_id_status: string | null;     // LIFF app ID for the candidate status page (RECRUITA only)
  oa_link: string | null;            // "add OA as friend" deep link (RECRUITA apply gate, RC-4)
  updated_at: string;
  updated_by: number | null;
};

const PLATFORM_CODE = "ikigai-os";
const RECRUITA_CODE = "ikigai-recruit";

/** Fallback "add IKIGAI Recruit OA" link (owner-provided 2026-06-14) used by
 *  the apply gate when messaging_channels.oa_link is NULL/empty. */
export const DEFAULT_RECRUITA_OA_LINK = "https://lin.ee/saEBWjQ";

/** Decrypt the secret/token fields on a row read from the DB. All
 *  read paths funnel through here so downstream callers see plaintext
 *  the same way they always did — encryption is invisible above this
 *  layer. */
function decryptRow<T extends MessagingChannel | undefined>(row: T): T {
  if (!row) return row;
  row.channel_secret = decryptSecret(row.channel_secret);
  row.channel_token = decryptSecret(row.channel_token);
  return row;
}

/** The IKIGAI OS platform channel (singleton). Returns null if not configured. */
export function getPlatformChannel(): MessagingChannel | null {
  const row = getDb().prepare(
    "SELECT * FROM messaging_channels WHERE code = ? LIMIT 1"
  ).get(PLATFORM_CODE) as MessagingChannel | undefined;
  return decryptRow(row) ?? null;
}

/** The IKIGAI Recruit OA (singleton). Separate channel so the
 *  candidate-facing notification stream doesn't bleed into the staff
 *  channel. Returns the row even when credentials are empty so the
 *  admin UI always has something to render. */
export function getRecruitaChannel(): MessagingChannel | null {
  const row = getDb().prepare(
    "SELECT * FROM messaging_channels WHERE code = ? LIMIT 1"
  ).get(RECRUITA_CODE) as MessagingChannel | undefined;
  return decryptRow(row) ?? null;
}

/** DELIVERA channels (scope='delivera'): customer ordering + ทีมงานส่งสุข. Each
 *  is a singleton keyed by code, configured in-app at /admin/delivera/connection.
 *  Returns the row even with empty creds so the admin UI can render it. */
export function getDeliveraChannel(kind: "customer" | "rider"): MessagingChannel | null {
  return getChannelByCode(kind === "customer" ? "delivera-customer" : "delivera-rider");
}

/** Look up any channel by its webhook code/slug. Used by the webhook router. */
export function getChannelByCode(code: string): MessagingChannel | null {
  const row = getDb().prepare(
    "SELECT * FROM messaging_channels WHERE code = ? LIMIT 1"
  ).get(code) as MessagingChannel | undefined;
  return decryptRow(row) ?? null;
}

/** All RESERVA per-branch channels, ordered by branch.display_order then label.
 *  NAMA (display_order=1) ends up first; new branches default to 100 and
 *  fall through to alphabetical-by-label. */
export function listReservaChannels(): MessagingChannel[] {
  const rows = getDb().prepare(`
    SELECT mc.*
    FROM messaging_channels mc
    LEFT JOIN branches b ON b.id = mc.branch_id
    WHERE mc.scope = 'reserva'
    ORDER BY COALESCE(b.display_order, 100), mc.label
  `).all() as MessagingChannel[];
  return rows.map((r) => decryptRow(r));
}

/** Partial-update credentials on any channel by code (platform or reserva).
 *  Same three-state semantics as setPlatformChannel:
 *    undefined = leave alone, "" = clear, non-empty = set. */
export function setChannelCreds(args: {
  code: string;
  channel_token?: string | undefined;
  channel_secret?: string | undefined;
  liff_id?: string | undefined;
  liff_id_status?: string | undefined;
  oa_link?: string | undefined;
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
    vals.push(v === "" ? null : encryptSecret(v));
  }
  if (args.channel_secret !== undefined) {
    sets.push("channel_secret = ?");
    const v = args.channel_secret.trim();
    vals.push(v === "" ? null : encryptSecret(v));
  }
  if (args.liff_id !== undefined) {
    // LIFF ID is not a secret — public-by-design (embedded in the
    // claim URL). Leave plaintext.
    sets.push("liff_id = ?");
    const v = args.liff_id.trim();
    vals.push(v === "" ? null : v);
  }
  if (args.liff_id_status !== undefined) {
    sets.push("liff_id_status = ?");
    const v = args.liff_id_status.trim();
    vals.push(v === "" ? null : v);
  }
  if (args.oa_link !== undefined) {
    // Public deep link — not a secret. Plaintext.
    sets.push("oa_link = ?");
    const v = args.oa_link.trim();
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
