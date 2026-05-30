// INSIGNA — Churn risk scoring (spec section 5.2).
//
// Daily-batch job. For each customer with ≥3 visits, derive an
// "expected interval" from their historical gap pattern (median),
// compare it to days-since-last-visit, and produce a normalised
// risk score:
//
//   expected = median(gaps between consecutive visits)
//   delta    = days_since_last_visit
//   score    = delta > expected * 1.5
//              ? min(1.0, delta / (expected * 3))
//              : 0
//
// The score is what powers GET /v1/analytics/churn-risk (outreach
// lists for marketing).
//
// Customers with <3 visits are skipped — we don't have enough
// gap signal to call their behaviour "expected", so labelling
// them as churning would be premature.

import { getDb } from "../db";
import { logInsignaEvent } from "./audit";

type VisitArrival = { arrived_at: string };

function median(sortedAsc: number[]): number {
  if (sortedAsc.length === 0) return 0;
  const mid = Math.floor(sortedAsc.length / 2);
  return sortedAsc.length % 2 === 0
    ? (sortedAsc[mid - 1] + sortedAsc[mid]) / 2
    : sortedAsc[mid];
}

function daysBetween(aIso: string, bIso: string): number {
  const ms = new Date(bIso).getTime() - new Date(aIso).getTime();
  return Math.max(0, ms / (1000 * 60 * 60 * 24));
}

/** Recompute the churn score for one customer. Returns the new
 *  score (0-1). Customers with <3 visits get 0 (insufficient data). */
export function recomputeChurnScore(customer_hash: string, now: Date = new Date()): number {
  const db = getDb();
  const visits = db.prepare(`
    SELECT arrived_at FROM insigna_visits
    WHERE customer_hash = ?
    ORDER BY arrived_at ASC
  `).all(customer_hash) as VisitArrival[];

  if (visits.length < 3) {
    db.prepare(
      "UPDATE insigna_customers SET churn_risk_score = 0 WHERE customer_hash = ?"
    ).run(customer_hash);
    return 0;
  }

  // Gap series. Use ASC arrivals so gaps[i] = visit[i+1] − visit[i].
  const gaps: number[] = [];
  for (let i = 1; i < visits.length; i++) {
    gaps.push(daysBetween(visits[i - 1].arrived_at, visits[i].arrived_at));
  }
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const expected = median(sortedGaps);

  const lastVisit = visits[visits.length - 1].arrived_at;
  const delta = daysBetween(lastVisit, now.toISOString());

  let score = 0;
  if (expected > 0 && delta > expected * 1.5) {
    score = Math.min(1, delta / (expected * 3));
  }
  // Round to 2dp to avoid storing noisy long floats.
  score = Math.round(score * 100) / 100;

  db.prepare(
    "UPDATE insigna_customers SET churn_risk_score = ? WHERE customer_hash = ?"
  ).run(score, customer_hash);

  return score;
}

/** Nightly batch: recompute churn for every customer with ≥3
 *  visits. Returns counts so the cron can log progress. */
export function recomputeAllChurn(now: Date = new Date()): {
  processed: number;
  high_risk: number;
} {
  const db = getDb();
  const eligible = db.prepare(`
    SELECT customer_hash, total_visits
    FROM insigna_customers
    WHERE total_visits >= 3
  `).all() as Array<{ customer_hash: string; total_visits: number }>;

  let processed = 0;
  let high_risk = 0;
  for (const e of eligible) {
    const s = recomputeChurnScore(e.customer_hash, now);
    processed += 1;
    if (s >= 0.5) high_risk += 1;
  }

  logInsignaEvent({
    event_type: "churn.batch",
    payload: { processed, high_risk }
  });

  return { processed, high_risk };
}

/** Read-side helper for the outreach list. Returns descending by
 *  score so the most-at-risk customers surface first. consent_marketing
 *  filter enforced here so the analytics endpoint can't accidentally
 *  serve customers who opted out of marketing contact. */
export function listHighChurnRisk(threshold = 0.5, limit = 100): Array<{
  customer_hash: string;
  churn_risk_score: number;
  total_visits: number;
  last_visit_at: string | null;
  persona_tag: string | null;
}> {
  return getDb().prepare(`
    SELECT customer_hash, churn_risk_score, total_visits, last_visit_at, persona_tag
    FROM insigna_customers
    WHERE churn_risk_score >= ?
      AND consent_marketing = 1
    ORDER BY churn_risk_score DESC, last_visit_at ASC
    LIMIT ?
  `).all(threshold, limit) as Array<{
    customer_hash: string;
    churn_risk_score: number;
    total_visits: number;
    last_visit_at: string | null;
    persona_tag: string | null;
  }>;
}
