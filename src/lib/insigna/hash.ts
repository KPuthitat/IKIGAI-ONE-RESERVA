// INSIGNA — Hash service (spec section 4.1, the most privacy-critical layer).
//
// Translates a real customer identifier (LINE userId, or in some
// walk-in flows a phone number) into a pseudonymous customer_hash
// the rest of INSIGNA stores. The wall between booking and INSIGNA
// is enforced HERE: callers pass the identifier in, we return the
// hash, we never store the input, we never log the input.
//
// Mode A (in-process) means this file is technically importable from
// anywhere — but no booking-system file SHOULD import it. The rule
// is "booking pushes events, INSIGNA hashes once internally". See
// the per-call site in lib/insigna/customers.ts for the boundary.
//
// Salt isolation: INSIGNA_SALT lives in process.env and is read here
// once at module load. It is intentionally NOT exported. A different
// salt per environment (dev / staging / prod) is required by spec
// section 6.9 — rotation procedure documented in README.

import crypto from "node:crypto";

// Read salt once. process.env lookup is cheap but we cache to make
// the rate-limit hot path tighter. A missing salt is fatal — refusing
// to start is safer than silently hashing with empty salt (which
// would make every customer_hash predictable from line_user_id).
const SALT = (() => {
  const s = (process.env.INSIGNA_SALT ?? "").trim();
  if (s.length < 32) {
    // Defer the throw — db.ts boot must succeed before this module
    // loads even in environments that haven't set the salt yet
    // (e.g. local dev before .env.local is filled in). The first
    // call to any hash function will throw a clear error instead.
    return null;
  }
  return s;
})();

function requireSalt(): string {
  if (!SALT) {
    throw new Error(
      "[INSIGNA] INSIGNA_SALT env var is missing or too short (need ≥32 chars). " +
      "Refusing to hash with empty/weak salt — every customer_hash would be " +
      "predictable from the LINE userId. Set INSIGNA_SALT in .env (or your " +
      "deployment config) to a random 64+ char string and restart."
    );
  }
  return SALT;
}

// ── Rate limiting (in-process token bucket) ────────────────────
// Mode A means anyone with access to this module can spam hash
// requests. Even though we don't expose an HTTP endpoint, a misuse
// in calling code (loop forgetting to break) shouldn't let an
// attacker brute-force LINE userIds → hash if SALT ever leaks
// separately. Per-process cap: 1000 hashes / sec sustained,
// burstable to 5000 momentarily. Anything beyond is a code bug.
const RATE_TOKENS_PER_SEC = 1000;
const RATE_BUCKET_MAX = 5000;
const bucket = {
  tokens: RATE_BUCKET_MAX,
  lastRefill: Date.now()
};
function consumeToken(): boolean {
  const now = Date.now();
  const elapsedMs = now - bucket.lastRefill;
  if (elapsedMs > 0) {
    bucket.tokens = Math.min(
      RATE_BUCKET_MAX,
      bucket.tokens + (elapsedMs / 1000) * RATE_TOKENS_PER_SEC
    );
    bucket.lastRefill = now;
  }
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** Internal HMAC-SHA256 over the salt. Returns 64-char lowercase
 *  hex string. Throws if the salt is unset or the rate limit is
 *  exhausted. NEVER logs the input. */
function hmac(input: string): string {
  if (!consumeToken()) {
    throw new Error("[INSIGNA] hash rate limit exceeded — investigate caller for a loop bug.");
  }
  return crypto.createHmac("sha256", requireSalt()).update(input).digest("hex");
}

/** Hash a LINE userId. The most common path — bookings made via
 *  the customer LINE OA route through here. Input is the LINE
 *  Messaging API userId ('U' + 32 hex). The output is opaque. */
export function hashLineUserId(lineUserId: string): string {
  if (!lineUserId || typeof lineUserId !== "string") {
    throw new Error("[INSIGNA] hashLineUserId requires a non-empty string");
  }
  return hmac(`line:${lineUserId.trim()}`);
}

/** Hash a phone number for walk-in flows where there's no LINE
 *  binding. The phone is normalised (digits only, leading 0
 *  stripped → "+66" form) before hashing so the same person punching
 *  "0812345678" and "+66812345678" lands on the same hash. */
export function hashPhone(phone: string): string {
  if (!phone || typeof phone !== "string") {
    throw new Error("[INSIGNA] hashPhone requires a non-empty string");
  }
  const digits = phone.replace(/\D+/g, "");
  if (digits.length < 9) {
    throw new Error("[INSIGNA] hashPhone: too few digits");
  }
  // 0XX-XXX-XXXX → 66XX-XXX-XXXX
  const normalised = digits.startsWith("0") ? `66${digits.slice(1)}` : digits;
  return hmac(`phone:${normalised}`);
}

/** Generate a one-shot anonymous hash for walk-in customers who
 *  refuse to give a phone number. Unique per visit — these rows
 *  can never be linked across visits, by design. The "anon:" prefix
 *  ensures the value collides with neither hashLineUserId nor
 *  hashPhone outputs (those have different prefixes). */
export function generateAnonymousHash(): string {
  return hmac(`anon:${crypto.randomBytes(16).toString("hex")}:${Date.now()}`);
}

/** Hash an arbitrary payload for the ingestion_audit trail.
 *  Used to record "this event was processed" without recording
 *  what the event contained. Not for customer-identity use. */
export function hashPayload(payload: unknown): string {
  const s = typeof payload === "string"
    ? payload
    : JSON.stringify(payload);
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** True iff a string looks like a valid customer_hash this module
 *  could have produced (64-char lowercase hex). Cheap pre-validation
 *  for the API layer so we don't have to query the DB just to
 *  reject obvious garbage. */
export function isCustomerHash(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
}
