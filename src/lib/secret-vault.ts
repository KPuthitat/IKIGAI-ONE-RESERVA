// At-rest encryption for LINE channel secrets + tokens.
//
// PDPA-driven hardening (2026-05): the database file lives on a VPS
// we don't own (DigitalOcean) and channel_secret / channel_token are
// the keys to the kingdom for sending LINE pushes as the brand. If
// the SQLite file ever leaked (backup misconfigured, droplet
// snapshot exposed) the attacker would have plaintext credentials
// for 4 LINE OAs. Encrypting at rest means the dump alone isn't
// enough — they'd also need RESERVA_SECRET_KEY from the env.
//
// Format on disk: every encrypted value is prefixed with "enc:v1:"
// so we can distinguish plaintext legacy rows (no prefix) from
// encrypted ones. The migration leaves legacy rows alone — they're
// re-encrypted on the next write via setChannelCreds.
//
// Cipher: AES-256-GCM with a per-row 96-bit IV. Tag is appended to
// the ciphertext blob before base64 encoding so a single roundtrip
// carries IV + tag + ciphertext.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.RESERVA_SECRET_KEY;
  if (!raw || raw.length < 16) {
    // Soft-fail to a deterministic dev key when not set so local
    // boot doesn't crash. Logs a warning so production deploys
    // notice immediately. In production the env MUST be set —
    // anything else means secrets are encrypted with a key any
    // codebase reader knows.
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "RESERVA_SECRET_KEY is required in production (min 16 chars)"
      );
    }
    console.warn(
      "[secret-vault] RESERVA_SECRET_KEY not set — using dev fallback. " +
      "DO NOT ship to production this way."
    );
    cachedKey = scryptSync("dev-fallback-key-do-not-use", "ikigai-os-salt", 32);
    return cachedKey;
  }
  // Stretch the env value into a 32-byte AES-256 key. Using scrypt
  // with a fixed salt keeps the derived key stable across boots
  // (rotating the env would need a re-encrypt migration).
  cachedKey = scryptSync(raw, "ikigai-os-vault-salt", 32);
  return cachedKey;
}

/** Encrypt a plaintext string. Returns the prefixed base64 blob
 *  ready to store. Pass-through on null / empty so the caller can
 *  always wrap a value without an if-statement. */
export function encryptSecret(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === "") return null;
  // Don't double-encrypt — if someone passes an already-encrypted
  // value back through (e.g. round-trip through an edit form that
  // shows the masked field), leave it alone.
  if (plain.startsWith(PREFIX)) return plain;

  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, tag, enc]).toString("base64");
  return PREFIX + blob;
}

/** Decrypt a stored value. Falls through to the input as-is when
 *  the value is plaintext (no prefix) — supports legacy rows that
 *  haven't been re-saved since the migration. */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined || stored === "") return null;
  if (!stored.startsWith(PREFIX)) return stored;  // legacy plaintext

  const blob = Buffer.from(stored.slice(PREFIX.length), "base64");
  if (blob.length < IV_LEN + TAG_LEN + 1) {
    console.warn("[secret-vault] decrypt: blob too short, returning null");
    return null;
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = blob.subarray(IV_LEN + TAG_LEN);
  try {
    const decipher = createDecipheriv(ALGO, getKey(), iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(enc), decipher.final()]);
    return out.toString("utf8");
  } catch (e) {
    console.warn("[secret-vault] decrypt failed:", e);
    return null;
  }
}

/** True when a stored value is in the encrypted format. Useful for
 *  the admin UI to show a "encrypted at rest" badge. */
export function isEncrypted(stored: string | null | undefined): boolean {
  return !!stored && stored.startsWith(PREFIX);
}
