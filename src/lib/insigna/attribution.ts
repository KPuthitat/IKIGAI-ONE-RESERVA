// INSIGNA — Multi-model attribution engine (spec §5.3).
//
// Computes "which campaign(s) deserve credit for this visit's
// revenue" using five canonical models. The result is one row per
// (visit, campaign, model) in insigna_attribution_ledger so a
// dashboard can switch models without recompute.
//
// All five models are computed on the same touchpoint list — we
// don't make the caller pick. The cost is 5×N inserts per visit;
// with the small touchpoint counts a single customer accumulates
// (handful, max), this is cheap and avoids "I want to compare
// models" being a re-run question later.
//
// Trigger: endVisit fires computeAttribution(visit_token) inline.
// Re-running on the same visit is safe — we DELETE existing rows
// first.

import { getDb } from "../db";
import { logInsignaEvent } from "./audit";

export type AttributionModel =
  | "first_touch"
  | "last_touch"
  | "linear"
  | "time_decay"
  | "position";

const ALL_MODELS: AttributionModel[] = [
  "first_touch", "last_touch", "linear", "time_decay", "position"
];

type Touchpoint = {
  campaign_id: string;
  channel: string;            // joined from campaigns; null safe is fine
  timestamp_ms: number;       // pre-converted for math
};

/** Time-decay weight: more recent touches get exponentially more
 *  credit. Half-life is fixed at 7 days, which means a touch from
 *  7 days before the visit weighs half as much as one on the visit
 *  day. Empirically that matches restaurant decision windows (people
 *  decide-and-go within a week of seeing the ad). */
function timeDecayWeight(touchpoint_ms: number, visit_ms: number): number {
  const daysAgo = Math.max(0, (visit_ms - touchpoint_ms) / (1000 * 60 * 60 * 24));
  const halfLifeDays = 7;
  return Math.pow(0.5, daysAgo / halfLifeDays);
}

/** Normalise a list of weights to sum to 1. Defensive against zero
 *  sums (touchpoint list empty or all decayed to 0). */
function normalise(weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) {
    // Even split as a fallback so credit isn't lost.
    return weights.map(() => 1 / weights.length);
  }
  return weights.map((w) => w / sum);
}

/** Per-model weight allocator. Returns an array of weights aligned
 *  with the input touchpoints, all summing to 1. */
function weightsFor(model: AttributionModel, touchpoints: Touchpoint[], visit_ms: number): number[] {
  const n = touchpoints.length;
  if (n === 0) return [];
  if (n === 1) return [1];

  switch (model) {
    case "first_touch":
      return touchpoints.map((_, i) => (i === 0 ? 1 : 0));

    case "last_touch":
      return touchpoints.map((_, i) => (i === n - 1 ? 1 : 0));

    case "linear":
      return touchpoints.map(() => 1 / n);

    case "time_decay": {
      const raw = touchpoints.map((t) => timeDecayWeight(t.timestamp_ms, visit_ms));
      return normalise(raw);
    }

    case "position": {
      // 40 / 40 / 20: first and last each get 40%, middles share 20%.
      // With n=2 we degenerate to 50/50 (spec doesn't specify; even
      // split is the kindest interpretation).
      if (n === 2) return [0.5, 0.5];
      const middleCount = n - 2;
      const middleEach = 0.2 / middleCount;
      return touchpoints.map((_, i) => {
        if (i === 0 || i === n - 1) return 0.4;
        return middleEach;
      });
    }
  }
}

/** Compute attribution for a single visit. Idempotent — wipes any
 *  prior rows for this visit before inserting fresh ones. */
export function computeAttribution(visit_token: string): {
  models_written: number;
  touchpoints_seen: number;
} {
  const db = getDb();

  const visit = db.prepare(`
    SELECT v.customer_hash, v.arrived_at,
           COALESCE(SUM(oi.unit_price * oi.quantity), 0) AS revenue
    FROM insigna_visits v
    LEFT JOIN insigna_order_items oi ON oi.visit_token = v.visit_token
    WHERE v.visit_token = ?
    GROUP BY v.visit_token
  `).get(visit_token) as
    | { customer_hash: string; arrived_at: string; revenue: number }
    | undefined;

  if (!visit) {
    throw new Error("[INSIGNA] computeAttribution: unknown visit_token");
  }

  const visit_ms = new Date(visit.arrived_at).getTime();

  // Touchpoints BEFORE the visit, oldest first — so weight indexes
  // align with chronological order (matters for first/last/position).
  const touchpoints = db.prepare(`
    SELECT t.campaign_id, t.timestamp,
           COALESCE(c.channel, '') AS channel
    FROM insigna_campaign_touchpoints t
    LEFT JOIN insigna_marketing_campaigns c ON c.campaign_id = t.campaign_id
    WHERE t.customer_hash = ?
      AND t.timestamp <= ?
    ORDER BY t.timestamp ASC
  `).all(visit.customer_hash, visit.arrived_at) as Array<{
    campaign_id: string;
    timestamp: string;
    channel: string;
  }>;

  const tps: Touchpoint[] = touchpoints.map((t) => ({
    campaign_id: t.campaign_id,
    channel: t.channel,
    timestamp_ms: new Date(t.timestamp).getTime()
  }));

  // Wipe prior attribution for this visit (idempotent re-run).
  db.prepare(
    "DELETE FROM insigna_attribution_ledger WHERE visit_token = ?"
  ).run(visit_token);

  if (tps.length === 0) {
    // No touchpoints → no attribution rows. Useful state to record
    // — auditing later "why isn't this visit attributed?" surfaces
    // an audit entry.
    logInsignaEvent({
      event_type: "attribution.compute",
      customer_hash: visit.customer_hash,
      payload: { visit_token, models_written: 0, touchpoints: 0 }
    });
    return { models_written: 0, touchpoints_seen: 0 };
  }

  const insert = db.prepare(`
    INSERT INTO insigna_attribution_ledger
      (visit_token, campaign_id, channel, attribution_model,
       attributed_revenue, attribution_weight)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    let inserted = 0;
    for (const model of ALL_MODELS) {
      const weights = weightsFor(model, tps, visit_ms);
      for (let i = 0; i < tps.length; i++) {
        const w = weights[i];
        if (w <= 0) continue;
        const w3 = Math.round(w * 1000) / 1000;       // 3dp weight
        const rev = Math.round(visit.revenue * w * 100) / 100;  // 2dp revenue
        insert.run(visit_token, tps[i].campaign_id, tps[i].channel, model, rev, w3);
        inserted += 1;
      }
    }
    return inserted;
  });
  const rows_written = tx();

  logInsignaEvent({
    event_type: "attribution.compute",
    customer_hash: visit.customer_hash,
    payload: { visit_token, models_written: rows_written, touchpoints: tps.length }
  });

  return { models_written: rows_written, touchpoints_seen: tps.length };
}

/** Channel-level aggregate (across visits + customers) for the
 *  given window and attribution model. Powers the analytics
 *  endpoint's "channel performance" view. */
export function channelPerformance(args: {
  from: string;          // ISO date
  to: string;            // ISO date
  model?: AttributionModel;
}): Array<{
  channel: string;
  visits: number;
  revenue: number;
}> {
  const model = args.model ?? "first_touch";
  return getDb().prepare(`
    SELECT al.channel,
           COUNT(DISTINCT al.visit_token) AS visits,
           ROUND(SUM(al.attributed_revenue), 2) AS revenue
    FROM insigna_attribution_ledger al
    JOIN insigna_visits v ON v.visit_token = al.visit_token
    WHERE al.attribution_model = ?
      AND v.arrived_at >= ?
      AND v.arrived_at <= ?
    GROUP BY al.channel
    ORDER BY revenue DESC
  `).all(model, args.from, args.to) as Array<{
    channel: string;
    visits: number;
    revenue: number;
  }>;
}
