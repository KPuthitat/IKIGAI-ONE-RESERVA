// Verification code generator for booking + walk-in flow.
//
// The code is shown to the customer (printed under the QR on the LINE
// Flex card, or read aloud by the staff member at the walk-in form)
// AND to the staff side when they scan the QR — staff confirms the
// two strings match before clicking "เคลมไอติม". A 6-char alphabet
// gives 32^6 ≈ 1B combinations; with our volume (~120 bookings per
// branch per month, retained 60 days = ~240 active codes at any time)
// the collision rate is negligible. We still retry on rare collisions
// via the UNIQUE-ish probe in `issueUniqueCode` below.
//
// Excluded chars (avoid hand-copy confusion):
//   0 / O   — both round
//   1 / I   — both vertical strokes
// Length 6 is short enough to read aloud but long enough that you
// can't brute-force-guess one even if you try.

import { randomInt } from "crypto";
import { getDb } from "./db";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars
const CODE_LEN = 6;

/** Generate one random 6-char code. Cryptographically random via
 *  `crypto.randomInt`. No DB check here — see `issueUniqueCode` for
 *  the de-dupe wrapper. */
export function generateCode(): string {
  let s = "";
  for (let i = 0; i < CODE_LEN; i++) {
    s += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return s;
}

/** Issue a verification code that's unique across both `bookings`
 *  AND `walk_in_visits` (staff scans the same code from either
 *  source). Retries up to 8 times; throws if it can't find a free
 *  code (would mean the space is saturated, which at our volume
 *  shouldn't happen in this century). */
export function issueUniqueCode(): string {
  const db = getDb();
  const probe = db.prepare(`
    SELECT 1 FROM bookings WHERE verification_code = ?
    UNION ALL
    SELECT 1 FROM walk_in_visits WHERE verification_code = ?
    LIMIT 1
  `);
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateCode();
    const hit = probe.get(code, code);
    if (!hit) return code;
  }
  throw new Error("verification_code: exhausted retries");
}

/** Normalise user-typed input — staff might type "x4f2k9" or with
 *  spaces / dashes. We strip everything that isn't in our alphabet
 *  and uppercase. Returns null if the cleaned result isn't the
 *  expected length, so the API can return a friendly "ไม่พบรหัส". */
export function normaliseCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.toUpperCase().replace(/[^A-Z2-9]/g, "");
  return cleaned.length === CODE_LEN ? cleaned : null;
}
