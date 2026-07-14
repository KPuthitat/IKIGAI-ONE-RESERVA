// Unit tests for the rotating clock-in code (owner 2026-07-14).
// Run: npm run test:clock
//
// Guarantees: current-window code verifies, a code from >skew windows ago is
// rejected, the ±skew tolerance holds, and a wrong secret never validates.

import {
  generateBranchSecret, currentClockCode, verifyClockCode, secondsUntilRollover,
  CLOCK_CODE_STEP_SEC
} from "../src/lib/clock-code";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

const STEP = CLOCK_CODE_STEP_SEC * 1000;
const secret = generateBranchSecret();
const other = generateBranchSecret();
// A fixed base time (not "now") so the test is deterministic.
const t0 = 1_800_000_000_000; // some ms; step-aligned enough for the math below

console.log("rotating clock code:");

// 1. Current-window code verifies at the same instant.
{
  const code = currentClockCode(secret, t0);
  ok("current code verifies now", verifyClockCode(secret, code, t0));
}

// 2. Code minted one window ago still verifies (skew = 1 → 30–60s window).
{
  const prev = currentClockCode(secret, t0 - STEP);
  ok("previous-window code still valid (skew 1)", verifyClockCode(secret, prev, t0));
}

// 3. Code from two windows ago is rejected (outside skew).
{
  const old = currentClockCode(secret, t0 - 2 * STEP);
  ok("two-windows-old code rejected", verifyClockCode(secret, old, t0) === false);
}

// 4. A future-window code (someone precomputed) is rejected — we only accept
//    current and past windows, never ahead.
{
  const future = currentClockCode(secret, t0 + STEP);
  ok("future-window code rejected", verifyClockCode(secret, future, t0) === false);
}

// 5. Wrong secret never validates a real code.
{
  const code = currentClockCode(secret, t0);
  ok("wrong secret rejected", verifyClockCode(other, code, t0) === false);
}

// 6. Garbage / wrong-shape input rejected (no throw).
{
  ok("empty code rejected", verifyClockCode(secret, "", t0) === false);
  ok("short code rejected", verifyClockCode(secret, "ABC", t0) === false);
  ok("lowercase normalised + still verifies", verifyClockCode(secret, currentClockCode(secret, t0).toLowerCase(), t0));
}

// 7. Code shape: 8 chars, base32 alphabet.
{
  const code = currentClockCode(secret, t0);
  ok("code is 8 base32 chars", /^[0-9A-HJKMNP-TV-Z]{8}$/.test(code));
}

// 8. Countdown is within (0, step].
{
  const s = secondsUntilRollover(t0);
  ok("countdown in (0, step]", s > 0 && s <= CLOCK_CODE_STEP_SEC);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
