// INSIGNA — Review funnel service (owner 2026-09-23).
//
// The customer opens /f/[branch-slug] from a QR / LINE link after a
// visit, rates 1-5 (+ optional axes + free-text), and lands on a
// thank-you screen that:
//   • grants a reward for COMPLETING the survey (never for a positive
//     rating and never for a Google review — that would break Google
//     policy on incentivised reviews), and
//   • offers the branch's Google "write a review" link to EVERYONE,
//     with wording that leans positive on a high score and apologetic
//     on a low one. It is deliberately NOT gated: routing only happy
//     customers to Google is review-gating, which Google prohibits.
//     Owner-confirmed the compliant design 2026-09-23.
//
// Storage (insigna_review_requests) keeps no name/phone/email. Its only
// identity link is the OPTIONAL customer_hash — the one-way INSIGNA
// pseudonym HMAC(line:<userId>), set when the review is opened from a
// LINE thank-you card and NULL for anonymous QR reviews. The raw LINE id
// lives briefly in the operational review_invites table (not INSIGNA) and
// is hashed at the call site; only the hash crosses into review storage.

import crypto from "node:crypto";
import { getDb } from "../db";
import { bkkDateIso, todayBkk } from "../time";
import { logInsignaEvent } from "./audit";

export type ReviewTier = "high" | "low";

export type ReviewConfig = {
  enabled: boolean;
  reward_text: string | null;   // null/empty = no reward step
  high_threshold: number;       // stars >= this = "high" tier
};

export type BranchReviewInfo = {
  branch_id: number;
  branch_name: string;
  branch_slug: string;
  google_review_url: string | null;
  customer_line_oa_url: string | null;   // the branch OA add-friend URL — source of the review-QR deep link
};

export type SubmitReviewArgs = {
  branch_id: number | null;
  rating: number;                       // 1-5, required
  food_rating?: number | null;
  service_rating?: number | null;
  ambience_rating?: number | null;
  return_intent?: boolean | null;       // "จะกลับมาอีกไหม", optional
  comment?: string | null;
  customer_hash?: string | null;        // INSIGNA pseudonym when identified via LINE; NULL for anonymous QR
};

export type SubmitReviewResult = {
  token: string;
  rating: number;
  tier: ReviewTier;
  google_review_url: string | null;     // the branch's, when configured
  reward_code: string | null;           // issued when a reward is configured
  reward_text: string | null;
};

export type ReviewRow = {
  token: string;
  branch_id: number | null;
  rating: number;
  food_rating: number | null;
  service_rating: number | null;
  ambience_rating: number | null;
  return_intent: number | null;
  comment: string | null;
  customer_hash: string | null;
  tier: ReviewTier;
  routed_google: number;
  clicked_google: number;
  reward_code: string | null;
  reward_claimed: number;
  reward_claimed_at: string | null;
  created_at: string;
};

// ── config ───────────────────────────────────────────────────────

/** Read the global review-funnel config from system_settings (row 1). */
export function getReviewConfig(): ReviewConfig {
  const row = getDb().prepare(`
    SELECT insigna_reviews_enabled       AS enabled,
           insigna_review_reward_text    AS reward_text,
           insigna_review_high_threshold AS high_threshold
    FROM system_settings WHERE id = 1
  `).get() as { enabled: number; reward_text: string | null; high_threshold: number } | undefined;
  return {
    enabled: !!row?.enabled,
    reward_text: row?.reward_text?.trim() || null,
    high_threshold: row?.high_threshold ?? 4
  };
}

/** Patch the global review-funnel config. Only the provided fields
 *  change. high_threshold is clamped to 2-5 (a threshold of 1 would
 *  make every rating "high"; above 5 is impossible). */
export function saveReviewConfig(patch: {
  enabled?: boolean;
  reward_text?: string | null;
  high_threshold?: number;
}): ReviewConfig {
  const db = getDb();
  if (patch.enabled !== undefined) {
    db.prepare("UPDATE system_settings SET insigna_reviews_enabled = ? WHERE id = 1")
      .run(patch.enabled ? 1 : 0);
  }
  if (patch.reward_text !== undefined) {
    db.prepare("UPDATE system_settings SET insigna_review_reward_text = ? WHERE id = 1")
      .run(patch.reward_text?.trim() || null);
  }
  if (patch.high_threshold !== undefined) {
    const clamped = Math.min(5, Math.max(2, Math.round(patch.high_threshold)));
    db.prepare("UPDATE system_settings SET insigna_review_high_threshold = ? WHERE id = 1")
      .run(clamped);
  }
  return getReviewConfig();
}

/** Set a branch's Google "write a review" link (admin config). Empty
 *  string clears it. */
export function setBranchGoogleUrl(branch_id: number, url: string | null): void {
  getDb().prepare("UPDATE branches SET google_review_url = ? WHERE id = ?")
    .run(url?.trim() || null, branch_id);
}

/** Resolve a branch by slug for the public page. Returns null when the
 *  slug is unknown so the caller can 404 without leaking branch list. */
export function getBranchReviewInfo(slug: string): BranchReviewInfo | null {
  const row = getDb().prepare(`
    SELECT id AS branch_id, name AS branch_name, slug AS branch_slug, google_review_url, customer_line_oa_url
    FROM branches WHERE slug = ?
  `).get(slug) as BranchReviewInfo | undefined;
  return row ?? null;
}

/** All branches with their Google-link state — for the admin config table. */
export function listBranchReviewInfo(): BranchReviewInfo[] {
  return getDb().prepare(`
    SELECT id AS branch_id, name AS branch_name, slug AS branch_slug, google_review_url, customer_line_oa_url
    FROM branches
    ORDER BY display_order, name
  `).all() as BranchReviewInfo[];
}

// ── submit ───────────────────────────────────────────────────────

const REWARD_ALPHABET = "ACDEFGHJKMNPQRSTUVWXYZ2345679"; // no ambiguous 0/O/1/I/L/B/8

function mintRewardCode(): string {
  const bytes = crypto.randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i++) out += REWARD_ALPHABET[bytes[i] % REWARD_ALPHABET.length];
  return `IK-${out}`;
}

function assertStar(v: number | null | undefined, label: string): void {
  if (v == null) return;
  if (!Number.isInteger(v) || v < 1 || v > 5) {
    throw new Error(`[INSIGNA] submitReview: ${label} must be an integer 1-5`);
  }
}

/** Record a completed review and return the routing payload for the
 *  thank-you screen. The reward code is minted here (once) whenever a
 *  reward is configured — the SAME code the customer shows staff on
 *  their next visit. Tier is computed against the configured
 *  threshold; the Google link is returned for BOTH tiers (no gating). */
export function submitReview(args: SubmitReviewArgs): SubmitReviewResult {
  assertStar(args.rating, "rating");
  if (args.rating == null) throw new Error("[INSIGNA] submitReview: rating is required");
  assertStar(args.food_rating, "food_rating");
  assertStar(args.service_rating, "service_rating");
  assertStar(args.ambience_rating, "ambience_rating");

  const cfg = getReviewConfig();
  const tier: ReviewTier = args.rating >= cfg.high_threshold ? "high" : "low";

  const db = getDb();
  const branch = args.branch_id != null
    ? db.prepare("SELECT google_review_url FROM branches WHERE id = ?").get(args.branch_id) as
        { google_review_url: string | null } | undefined
    : undefined;
  const googleUrl = branch?.google_review_url?.trim() || null;

  const token = crypto.randomBytes(9).toString("base64url");
  const rewardCode = cfg.reward_text ? mintRewardCode() : null;

  db.prepare(`
    INSERT INTO insigna_review_requests
      (token, branch_id, rating, food_rating, service_rating, ambience_rating,
       return_intent, comment, customer_hash, tier, routed_google, reward_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    token,
    args.branch_id ?? null,
    args.rating,
    args.food_rating ?? null,
    args.service_rating ?? null,
    args.ambience_rating ?? null,
    args.return_intent == null ? null : (args.return_intent ? 1 : 0),
    args.comment?.trim() || null,
    args.customer_hash ?? null,
    tier,
    googleUrl ? 1 : 0,
    rewardCode
  );

  logInsignaEvent({
    event_type: "review.submit",
    customer_hash: null,
    payload: { branch_id: args.branch_id, rating: args.rating, tier, has_comment: !!args.comment }
  });

  return {
    token,
    rating: args.rating,
    tier,
    google_review_url: googleUrl,
    reward_code: rewardCode,
    reward_text: cfg.reward_text
  };
}

// ── invite links (identify a review via LINE without storing PII) ───

export type ResolvedInvite = { line_user_id: string; branch_id: number | null };

/** Mint an opaque invite token for a LINE thank-you card. The token maps
 *  to this customer's LINE userId in review_invites (operational table,
 *  not INSIGNA); the id is hashed only at submit. Default TTL 30 days. */
export function createReviewInvite(lineUserId: string, branchId: number | null, ttlDays = 30): string {
  if (!lineUserId?.trim()) throw new Error("[INSIGNA] createReviewInvite: lineUserId required");
  const token = crypto.randomBytes(12).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlDays * 86400000).toISOString();
  getDb().prepare(`
    INSERT INTO review_invites (token, line_user_id, branch_id, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(token, lineUserId.trim(), branchId ?? null, expiresAt);
  return token;
}

/** Resolve an invite token to its LINE userId (+ branch). Returns null
 *  when unknown or expired — the review still records, just anonymously.
 *  An expired row is deleted on encounter (its raw LINE id shouldn't
 *  linger); reusable until it expires (a customer may reopen the link). */
export function resolveReviewInvite(token: string): ResolvedInvite | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT line_user_id, branch_id, expires_at FROM review_invites WHERE token = ?"
  ).get(token) as { line_user_id: string; branch_id: number | null; expires_at: string | null } | undefined;
  if (!row) return null;
  if (row.expires_at && row.expires_at < new Date().toISOString()) {
    db.prepare("DELETE FROM review_invites WHERE token = ?").run(token);
    return null;
  }
  return { line_user_id: row.line_user_id, branch_id: row.branch_id };
}

/** True if this LINE user already got a review invite for this branch within
 *  the last `withinSeconds`. Dedups LINE webhook retries and a customer
 *  spamming the review keyword, so we don't push a stack of rating cards.
 *  Compared in SQL so it matches review_invites.created_at (UTC "YYYY-MM-DD
 *  HH:MM:SS"), which a JS ISO string would not. */
export function recentReviewInviteExists(
  lineUserId: string, branchId: number | null, withinSeconds = 600
): boolean {
  const row = getDb().prepare(
    `SELECT 1 FROM review_invites
     WHERE line_user_id = ? AND branch_id IS ? AND created_at >= datetime('now', ?) LIMIT 1`
  ).get(lineUserId, branchId, `-${Math.max(1, Math.floor(withinSeconds))} seconds`);
  return !!row;
}

/** How many reward-bearing reviews this identified customer already has at a
 *  branch. Gates the OA reward push so a resubmit (the invite token is
 *  reusable) or a repeat visit doesn't stack reward cards — the reward is 1
 *  per customer per branch, so we only push when this is their only code. */
export function customerRewardCountAtBranch(customer_hash: string, branch_id: number | null): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) AS n FROM insigna_review_requests
     WHERE customer_hash = ? AND branch_id IS ? AND reward_code IS NOT NULL`
  ).get(customer_hash, branch_id) as { n: number };
  return row.n;
}

/** Delete expired invite rows so raw LINE ids don't accumulate past their
 *  validity window. Wire into the nightly cron. Returns rows removed. */
export function purgeExpiredReviewInvites(): number {
  const res = getDb().prepare(
    "DELETE FROM review_invites WHERE expires_at IS NOT NULL AND expires_at < ?"
  ).run(new Date().toISOString());
  return res.changes;
}

/** Mark that the customer tapped through to Google (conversion signal).
 *  Idempotent — a double-tap stays 1. Unknown token is a silent no-op. */
export function trackGoogleClick(token: string): void {
  getDb().prepare(
    "UPDATE insigna_review_requests SET clicked_google = 1 WHERE token = ?"
  ).run(token);
}

export type ClaimResult =
  | "claimed"
  | "already"           // THIS code was already redeemed
  | "unknown"           // no such code
  | "same_day"          // redeemed on the same Bangkok day as the review
  | "already_redeemed"; // this customer has already used a reward at this branch

/** Redeem a reward code (staff scans/enters it on a LATER visit).
 *
 *  Owner rules (2026-09-24):
 *   • NOT on the same Bangkok day the survey was filled — the reward is for
 *     a return visit, not the visit being reviewed → 'same_day'. (It need
 *     not be the very next visit, just not that same day.)
 *   • ONE reward per identified customer PER BRANCH — customer_hash is set
 *     when the review came in via a LINE card, so if that customer has
 *     already redeemed a reward AT THIS BRANCH, refuse → 'already_redeemed'
 *     (they may still redeem once at the other branch). Anonymous QR reviews
 *     carry no hash, so only the same-day + per-code guards apply to them.
 *
 *  Returns 'claimed' on success, 'already' if THIS code was already used,
 *  'unknown' if the code doesn't exist. */
export function claimReward(reward_code: string): ClaimResult {
  const db = getDb();
  const code = reward_code.trim().toUpperCase();
  const row = db.prepare(
    "SELECT token, reward_claimed, customer_hash, branch_id, created_at FROM insigna_review_requests WHERE reward_code = ?"
  ).get(code) as
    { token: string; reward_claimed: number; customer_hash: string | null; branch_id: number | null; created_at: string } | undefined;
  if (!row) return "unknown";
  if (row.reward_claimed) return "already";

  // Not redeemable on the same Bangkok day the survey was filled.
  if (bkkDateIso(row.created_at) === todayBkk()) return "same_day";

  // One reward per identified customer PER BRANCH. `branch_id IS ?` is
  // null-safe so a branchless review only collides with another branchless one.
  if (row.customer_hash) {
    const prior = db.prepare(
      "SELECT 1 FROM insigna_review_requests WHERE customer_hash = ? AND branch_id IS ? AND reward_claimed = 1 LIMIT 1"
    ).get(row.customer_hash, row.branch_id);
    if (prior) return "already_redeemed";
  }

  // Guard the write itself so a double-scan can't claim twice.
  const res = db.prepare(
    "UPDATE insigna_review_requests SET reward_claimed = 1, reward_claimed_at = CURRENT_TIMESTAMP WHERE token = ? AND reward_claimed = 0"
  ).run(row.token);
  return res.changes ? "claimed" : "already";
}

// ── read surface (admin หลังบ้าน) ────────────────────────────────

export type ReviewSummary = {
  total: number;
  avg: number | null;
  dist: Record<1 | 2 | 3 | 4 | 5, number>;   // count per star
  lowCount: number;                            // tier === 'low'
  googleShown: number;                         // routed_google = 1
  googleClicked: number;                       // clicked_google = 1
  rewardsIssued: number;
  rewardsClaimed: number;
};

function sinceClause(days: number | null): { clause: string; params: string[] } {
  if (!days || days <= 0) return { clause: "", params: [] };
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return { clause: " AND created_at >= ?", params: [cutoff] };
}

/** Aggregate stats for the admin dashboard. branch_id null = all
 *  branches; days null = all time. */
export function reviewSummary(opts: { branch_id?: number | null; days?: number | null } = {}): ReviewSummary {
  const db = getDb();
  const branchFilter = opts.branch_id != null ? " AND branch_id = ?" : "";
  const branchParams: Array<string | number> = opts.branch_id != null ? [opts.branch_id] : [];
  const { clause, params } = sinceClause(opts.days ?? null);
  const where = `WHERE 1=1${branchFilter}${clause}`;
  const p = [...branchParams, ...params];

  const rows = db.prepare(
    `SELECT rating, tier, routed_google, clicked_google, reward_code, reward_claimed
     FROM insigna_review_requests ${where}`
  ).all(...p) as Array<{
    rating: number; tier: string; routed_google: number; clicked_google: number;
    reward_code: string | null; reward_claimed: number;
  }>;

  const dist: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0, lowCount = 0, googleShown = 0, googleClicked = 0, rewardsIssued = 0, rewardsClaimed = 0;
  for (const r of rows) {
    dist[r.rating as 1 | 2 | 3 | 4 | 5] += 1;
    sum += r.rating;
    if (r.tier === "low") lowCount += 1;
    if (r.routed_google) googleShown += 1;
    if (r.clicked_google) googleClicked += 1;
    if (r.reward_code) rewardsIssued += 1;
    if (r.reward_claimed) rewardsClaimed += 1;
  }
  return {
    total: rows.length,
    avg: rows.length ? Math.round((sum / rows.length) * 100) / 100 : null,
    dist, lowCount, googleShown, googleClicked, rewardsIssued, rewardsClaimed
  };
}

/** Recent reviews for the list view. Optional tier filter (e.g. only
 *  'low' for the service-recovery queue). */
export function listReviews(opts: {
  branch_id?: number | null; tier?: ReviewTier | null; limit?: number;
} = {}): ReviewRow[] {
  const db = getDb();
  const parts: string[] = ["1=1"];
  const params: Array<string | number> = [];
  if (opts.branch_id != null) { parts.push("branch_id = ?"); params.push(opts.branch_id); }
  if (opts.tier) { parts.push("tier = ?"); params.push(opts.tier); }
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  return db.prepare(
    `SELECT * FROM insigna_review_requests WHERE ${parts.join(" AND ")}
     ORDER BY created_at DESC LIMIT ?`
  ).all(...params, limit) as ReviewRow[];
}
