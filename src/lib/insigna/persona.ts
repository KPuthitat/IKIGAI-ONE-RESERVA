// INSIGNA — Persona tagging engine (spec section 5.1).
//
// Rule-based classification: after every visit ends, look at the
// customer's accumulated arrival-time / party-type / weekday
// patterns and assign a persona_tag. Phase 1 keeps the rules
// transparent (mode of bucketed signals) so the tag is auditable
// from a SQL window; Phase 2 will layer LLM-derived nuance on top
// in synthesizePersonaDescription.
//
// Why mode and not anything fancier: with only a few visits per
// customer in early data, anything more elaborate (k-means etc.)
// overfits to noise. Mode of categorical buckets is robust and
// gives the staff a tag they can act on immediately.

import { getDb } from "../db";
import { logInsignaEvent } from "./audit";

type VisitRow = {
  arrived_at: string;
  party_type: string;
};

type PersonaTag =
  | "NEW"
  | "WEEKEND_DATE_NIGHT"
  | "SOLO_LUNCH_REGULAR"
  | "FAMILY_WEEKEND"
  | "BUSINESS_LUNCH"
  | "CASUAL";

function bucketTime(iso: string): "LUNCH" | "DINNER" | "LATE" {
  // Bangkok hour-of-day. iso is UTC; +7h.
  const bkkHour = new Date(new Date(iso).getTime() + 7 * 60 * 60 * 1000).getUTCHours();
  if (bkkHour < 15) return "LUNCH";
  if (bkkHour < 21) return "DINNER";
  return "LATE";
}

function bucketDay(iso: string): "WEEKEND" | "WEEKDAY" {
  // 0 = Sunday, 6 = Saturday → weekend; everything else weekday.
  // Use Bangkok-shifted date so a Saturday-night-into-Sunday-morning
  // visit lands on the night the customer perceived it.
  const bkk = new Date(new Date(iso).getTime() + 7 * 60 * 60 * 1000);
  const dow = bkk.getUTCDay();
  return dow === 0 || dow === 6 ? "WEEKEND" : "WEEKDAY";
}

function mode<T extends string>(values: T[]): T | null {
  if (values.length === 0) return null;
  const counts = new Map<T, number>();
  let best: T = values[0];
  let bestCount = 0;
  for (const v of values) {
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (n > bestCount) {
      best = v;
      bestCount = n;
    }
  }
  return best;
}

/** Spec section 5.1 rules. */
function classify(visits: VisitRow[]): PersonaTag {
  if (visits.length < 2) return "NEW";

  const times = visits.map((v) => bucketTime(v.arrived_at));
  const days = visits.map((v) => bucketDay(v.arrived_at));
  const parties = visits.map((v) => v.party_type);

  const dominantTime = mode(times);
  const dominantDay = mode(days);
  const dominantParty = mode(parties);

  if (dominantParty === "COUPLE" && dominantDay === "WEEKEND" && dominantTime === "DINNER") {
    return "WEEKEND_DATE_NIGHT";
  }
  if (dominantParty === "SOLO" && dominantTime === "LUNCH") {
    return "SOLO_LUNCH_REGULAR";
  }
  if (dominantParty === "FAMILY" && dominantDay === "WEEKEND") {
    return "FAMILY_WEEKEND";
  }
  if (dominantParty === "BUSINESS" && dominantTime === "LUNCH") {
    return "BUSINESS_LUNCH";
  }
  return "CASUAL";
}

/** Pull this customer's full visit history and recompute the
 *  persona_tag, persisting the new value. Returns the new tag. */
export function recomputePersonaTag(customer_hash: string): PersonaTag | null {
  const db = getDb();
  const visits = db.prepare(`
    SELECT arrived_at, party_type
    FROM insigna_visits
    WHERE customer_hash = ?
    ORDER BY arrived_at DESC
    LIMIT 50
  `).all(customer_hash) as VisitRow[];

  if (visits.length === 0) return null;

  const tag = classify(visits);
  db.prepare(
    "UPDATE insigna_customers SET persona_tag = ? WHERE customer_hash = ?"
  ).run(tag, customer_hash);

  logInsignaEvent({
    event_type: "persona.recompute",
    customer_hash,
    payload: { tag, visit_count: visits.length }
  });

  return tag;
}

/** Batch — recompute every customer with at least one visit.
 *  Used by the nightly job (spec section 5.4-adjacent: persona is
 *  computed daily as a side effect of the rollup window). Cheap;
 *  one query per customer + one UPDATE. */
export function recomputeAllPersonas(): { processed: number } {
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT customer_hash FROM insigna_visits
  `).all() as Array<{ customer_hash: string }>;
  let processed = 0;
  for (const r of rows) {
    recomputePersonaTag(r.customer_hash);
    processed += 1;
  }
  return { processed };
}
