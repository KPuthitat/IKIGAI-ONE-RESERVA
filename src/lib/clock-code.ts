// Rotating clock-in QR code (owner 2026-07-14).
//
// The door display shows a short code that changes every STEP_SEC seconds; the
// staff scans it and the clock route verifies it here. It's a TOTP-style HMAC
// of a per-branch secret + the current time step, so:
//   - a photographed/screenshotted QR expires in ≤ (STEP_SEC × (skew+1)) sec,
//     so it can't be shared for later or from home;
//   - only someone holding the branch secret (the server) can mint valid codes.
//
// Location is still proven by the GPS geofence in the clock route — this layer
// is anti-share + smooth scanning, not a substitute for geofence.
//
// crypto is a Node built-in; this module is server-only (never import into a
// client component — it would leak the secret).

import { createHmac, randomBytes, timingSafeEqual } from "crypto";

export const CLOCK_CODE_STEP_SEC = 30;
// Accept the current window plus this many prior windows, to tolerate clock
// skew between the display device and the server + the few seconds between the
// QR rendering and the staff scanning it. 1 → codes live ~30–60s.
export const CLOCK_CODE_SKEW = 1;

/** A fresh per-branch secret (hex). Stored in branches.clock_totp_secret. */
export function generateBranchSecret(): string {
  return randomBytes(32).toString("hex");
}

// Truncate the HMAC to an 8-char base32 code (Crockford-ish, no padding). Short
// enough to render as a crisp QR, long enough (40 bits) that guessing within a
// 30s window is infeasible.
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function hmacCode(secret: string, step: number): string {
  const mac = createHmac("sha256", secret).update(String(step)).digest();
  let out = "";
  for (let i = 0; i < 8; i++) out += B32[mac[i] & 31];
  return out;
}

function stepFor(nowMs: number, stepSec: number): number {
  return Math.floor(nowMs / 1000 / stepSec);
}

/** The code to display right now for a branch secret. */
export function currentClockCode(
  secret: string,
  nowMs: number,
  stepSec: number = CLOCK_CODE_STEP_SEC
): string {
  return hmacCode(secret, stepFor(nowMs, stepSec));
}

/** Seconds until the current code rolls over — for the display countdown. */
export function secondsUntilRollover(
  nowMs: number,
  stepSec: number = CLOCK_CODE_STEP_SEC
): number {
  const s = Math.floor(nowMs / 1000);
  return stepSec - (s % stepSec);
}

/** True when `code` matches the current window or one of the previous `skew`
 *  windows. Constant-time compare per candidate. */
export function verifyClockCode(
  secret: string,
  code: string,
  nowMs: number,
  opts: { stepSec?: number; skew?: number } = {}
): boolean {
  const stepSec = opts.stepSec ?? CLOCK_CODE_STEP_SEC;
  const skew = opts.skew ?? CLOCK_CODE_SKEW;
  const candidate = (code ?? "").trim().toUpperCase();
  if (!/^[0-9A-Z]{8}$/.test(candidate)) return false;
  const cand = Buffer.from(candidate);
  const now = stepFor(nowMs, stepSec);
  for (let d = 0; d <= skew; d++) {
    const expected = Buffer.from(hmacCode(secret, now - d));
    if (expected.length === cand.length && timingSafeEqual(expected, cand)) {
      return true;
    }
  }
  return false;
}
