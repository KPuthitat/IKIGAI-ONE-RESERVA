// Signed, expiring link token for the LINE bill-detail form (owner 2026-06-29).
// A staff member sends a bill photo → the reply card carries a tokenised URL to
// /bill/<token> where they pick the doc type + fill total/tax and submit for
// admin review. The token authorises editing that ONE draft for a limited time
// (HMAC over id+expiry — same scheme as the Google Drive OAuth state), so the
// form needs no login while staying unguessable. Admin still confirms the draft.
import crypto from "node:crypto";

function secret(): string {
  return process.env.RESERVA_SECRET_KEY || "accounta-bill-token";
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function signBillToken(expenseId: number, ttlMs: number = DEFAULT_TTL_MS): string {
  const exp = Date.now() + ttlMs;
  const payload = `${expenseId}.${exp}`;
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest("hex").slice(0, 32);
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

/** Returns the expense id if the token is valid and unexpired, else null. */
export function verifyBillToken(token: string): number | null {
  try {
    const [id, exp, sig] = Buffer.from(token, "base64url").toString().split(".");
    if (!id || !exp || !sig) return null;
    const expect = crypto.createHmac("sha256", secret()).update(`${id}.${exp}`).digest("hex").slice(0, 32);
    if (sig !== expect) return null;
    if (Date.now() > Number(exp)) return null;
    const n = Number(id);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
