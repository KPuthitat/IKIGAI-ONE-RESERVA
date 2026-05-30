// INSIGNA — Referral codes (spec §3.11, §4.6).
//
// A customer "owns" a referral code; friends use it; the owner gets
// attributed revenue for downstream visits. The code is short and
// human-readable (8 base32 chars) so customers can speak it aloud
// or scan a QR.

import crypto from "node:crypto";
import { getDb } from "../db";
import { isCustomerHash } from "./hash";
import { logInsignaEvent } from "./audit";

const CODE_LEN = 8;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";  // no O/0, I/1, L → less misreads

/** Generate a random code, retrying on collision (vanishingly rare
 *  at 30^8 ≈ 6.5e11 space but cheaply guarded). */
function generateCode(db: ReturnType<typeof getDb>): string {
  for (let attempt = 0; attempt < 5; attempt++) {
    const bytes = crypto.randomBytes(CODE_LEN);
    let code = "";
    for (let i = 0; i < CODE_LEN; i++) {
      code += ALPHABET[bytes[i] % ALPHABET.length];
    }
    const exists = db.prepare(
      "SELECT 1 FROM insigna_referral_codes WHERE code = ?"
    ).get(code);
    if (!exists) return code;
  }
  throw new Error("[INSIGNA] generateCode: 5 collisions in a row — bug?");
}

/** Mint a new referral code for the given customer. Optional
 *  expires_in_days defaults to "never" (NULL). Returns the code. */
export function createReferralCode(args: {
  owner_customer_hash: string;
  expires_in_days?: number;
}): { code: string } {
  if (!isCustomerHash(args.owner_customer_hash)) {
    throw new Error("[INSIGNA] createReferralCode: invalid owner hash");
  }
  const db = getDb();
  const code = generateCode(db);
  const expires_at = args.expires_in_days
    ? new Date(Date.now() + args.expires_in_days * 24 * 60 * 60 * 1000).toISOString()
    : null;
  db.prepare(`
    INSERT INTO insigna_referral_codes
      (code, owner_customer_hash, expires_at)
    VALUES (?, ?, ?)
  `).run(code, args.owner_customer_hash, expires_at);
  logInsignaEvent({
    event_type: "referral.create",
    customer_hash: args.owner_customer_hash,
    payload: { code }
  });
  return { code };
}

/** A new customer uses an existing code. We bump uses_count
 *  immediately; converted_count + total_attributed_revenue update
 *  when the new customer's first visit ends (handled by the
 *  attribution recompute, which writes a touchpoint-style row to
 *  the campaign_touchpoints table under a synthetic referral
 *  "campaign"). */
export function redeemReferralCode(args: {
  code: string;
  new_customer_hash: string;
}): { ok: true; owner_customer_hash: string } | { ok: false; reason: string } {
  if (!isCustomerHash(args.new_customer_hash)) {
    return { ok: false, reason: "invalid_new_hash" };
  }
  const db = getDb();
  const row = db.prepare(`
    SELECT owner_customer_hash, expires_at
    FROM insigna_referral_codes
    WHERE code = ?
  `).get(args.code) as { owner_customer_hash: string; expires_at: string | null } | undefined;

  if (!row) return { ok: false, reason: "unknown_code" };
  if (row.owner_customer_hash === args.new_customer_hash) {
    return { ok: false, reason: "self_referral" };
  }
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }

  db.prepare(
    "UPDATE insigna_referral_codes SET uses_count = uses_count + 1 WHERE code = ?"
  ).run(args.code);

  // Stamp acquisition on the new customer so attribution can route
  // credit back to the owner via the referral channel.
  db.prepare(`
    UPDATE insigna_customers
    SET acquisition_source = COALESCE(acquisition_source, ?),
        acquisition_campaign = COALESCE(acquisition_campaign, ?),
        acquisition_date = COALESCE(acquisition_date, CURRENT_TIMESTAMP)
    WHERE customer_hash = ?
  `).run("referral", `referral:${args.code}`, args.new_customer_hash);

  logInsignaEvent({
    event_type: "referral.redeem",
    customer_hash: args.new_customer_hash,
    payload: { code: args.code, owner: row.owner_customer_hash }
  });

  return { ok: true, owner_customer_hash: row.owner_customer_hash };
}

/** Pull this customer's referral leaderboard entry. Useful for a
 *  "share your code" UI in the LIFF — shows uses, conversions, and
 *  total revenue attributed to their friends' visits. */
export function getReferralStats(owner_customer_hash: string): Array<{
  code: string;
  uses_count: number;
  converted_count: number;
  total_attributed_revenue: number;
  created_at: string;
  expires_at: string | null;
}> {
  return getDb().prepare(`
    SELECT code, uses_count, converted_count, total_attributed_revenue,
           created_at, expires_at
    FROM insigna_referral_codes
    WHERE owner_customer_hash = ?
    ORDER BY created_at DESC
  `).all(owner_customer_hash) as Array<{
    code: string;
    uses_count: number;
    converted_count: number;
    total_attributed_revenue: number;
    created_at: string;
    expires_at: string | null;
  }>;
}
