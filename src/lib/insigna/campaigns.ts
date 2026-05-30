// INSIGNA — Marketing campaigns + touchpoints (spec §3.8, §3.9, §4.6).
//
// Owner / admin creates campaigns (channel, budget, dates). When a
// customer interacts with a campaign (sees the ad, clicks it, saves
// a post, shares it), we log a touchpoint row anchored to the
// pseudonymous customer_hash. Those touchpoints feed the attribution
// engine — it doesn't compute spend-to-revenue; this module just
// stores the signal.

import { getDb } from "../db";
import { isCustomerHash } from "./hash";
import { logInsignaEvent } from "./audit";

export type InsignaCampaign = {
  campaign_id: string;
  channel: string;
  campaign_name: string;
  start_date: string;
  end_date: string | null;
  budget: number;
  actual_spend: number;
  goal_metric: string | null;
  notes: string | null;
};

type CreateArgs = {
  campaign_id: string;          // caller-provided slug e.g. "fb_summer_2026"
  channel: string;              // "facebook", "google", "tiktok", "ig", "line_oa"
  campaign_name: string;
  start_date: string;
  end_date?: string | null;
  budget?: number;
  goal_metric?: string | null;
  notes?: string | null;
};

/** Upsert a campaign by its slug. Slug doubles as the analytics
 *  join key, so it must be unique + meaningful (the admin picks it). */
export function upsertCampaign(args: CreateArgs): InsignaCampaign {
  const db = getDb();
  db.prepare(`
    INSERT INTO insigna_marketing_campaigns
      (campaign_id, channel, campaign_name, start_date, end_date, budget, goal_metric, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(campaign_id) DO UPDATE SET
      channel = excluded.channel,
      campaign_name = excluded.campaign_name,
      start_date = excluded.start_date,
      end_date = excluded.end_date,
      budget = excluded.budget,
      goal_metric = excluded.goal_metric,
      notes = excluded.notes
  `).run(
    args.campaign_id, args.channel, args.campaign_name,
    args.start_date, args.end_date ?? null,
    args.budget ?? 0, args.goal_metric ?? null, args.notes ?? null
  );
  logInsignaEvent({ event_type: "campaign.upsert", payload: { campaign_id: args.campaign_id } });
  return db.prepare(
    "SELECT * FROM insigna_marketing_campaigns WHERE campaign_id = ?"
  ).get(args.campaign_id) as InsignaCampaign;
}

/** Update actual_spend (typically a daily import from ad platform).
 *  Stored absolute, not delta, so re-runs are idempotent. */
export function setCampaignSpend(campaign_id: string, spend: number): void {
  getDb().prepare(
    "UPDATE insigna_marketing_campaigns SET actual_spend = ? WHERE campaign_id = ?"
  ).run(spend, campaign_id);
}

export function listCampaigns(opts: {
  channel?: string;
  active_on?: string;        // YYYY-MM-DD — narrows to "running on this date"
} = {}): InsignaCampaign[] {
  const where: string[] = [];
  const vals: Array<string> = [];
  if (opts.channel) { where.push("channel = ?"); vals.push(opts.channel); }
  if (opts.active_on) {
    where.push("start_date <= ? AND (end_date IS NULL OR end_date >= ?)");
    vals.push(opts.active_on, opts.active_on);
  }
  const sql = `
    SELECT * FROM insigna_marketing_campaigns
    ${where.length > 0 ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY start_date DESC
  `;
  return getDb().prepare(sql).all(...vals) as InsignaCampaign[];
}

type TouchpointArgs = {
  customer_hash: string;
  campaign_id: string;
  touchpoint_type: string;      // "view" | "click" | "save" | "share" — open enum
  timestamp?: string;           // ISO; defaults to now
  metadata?: Record<string, unknown> | null;
};

/** Append a touchpoint. The attribution engine reads these rows in
 *  chronological order to allocate credit. */
export function addTouchpoint(args: TouchpointArgs): void {
  if (!isCustomerHash(args.customer_hash)) {
    throw new Error("[INSIGNA] addTouchpoint: invalid customer_hash");
  }
  getDb().prepare(`
    INSERT INTO insigna_campaign_touchpoints
      (customer_hash, campaign_id, touchpoint_type, timestamp, metadata)
    VALUES (?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?)
  `).run(
    args.customer_hash, args.campaign_id,
    args.touchpoint_type, args.timestamp ?? null,
    args.metadata ? JSON.stringify(args.metadata) : null
  );
  logInsignaEvent({
    event_type: "touchpoint.add",
    customer_hash: args.customer_hash,
    payload: { campaign_id: args.campaign_id, type: args.touchpoint_type }
  });
}

/** Read raw performance numbers for a campaign — visits attributed,
 *  revenue, ROAS. Combines the campaign row with the attribution
 *  ledger for the given model (default first_touch). */
export function getCampaignPerformance(args: {
  campaign_id: string;
  attribution_model?: "first_touch" | "last_touch" | "linear" | "time_decay" | "position";
}): {
  campaign: InsignaCampaign | null;
  attributed_visits: number;
  attributed_revenue: number;
  roas: number | null;
} {
  const db = getDb();
  const model = args.attribution_model ?? "first_touch";
  const campaign = db.prepare(
    "SELECT * FROM insigna_marketing_campaigns WHERE campaign_id = ?"
  ).get(args.campaign_id) as InsignaCampaign | undefined;
  if (!campaign) {
    return { campaign: null, attributed_visits: 0, attributed_revenue: 0, roas: null };
  }
  const stats = db.prepare(`
    SELECT
      COUNT(DISTINCT visit_token) AS visits,
      COALESCE(SUM(attributed_revenue), 0) AS revenue
    FROM insigna_attribution_ledger
    WHERE campaign_id = ? AND attribution_model = ?
  `).get(args.campaign_id, model) as { visits: number; revenue: number };
  const roas = campaign.actual_spend > 0
    ? stats.revenue / campaign.actual_spend
    : null;
  return {
    campaign,
    attributed_visits: stats.visits,
    attributed_revenue: stats.revenue,
    roas
  };
}
