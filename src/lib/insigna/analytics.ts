// INSIGNA — Analytics read service (spec §4.7).
//
// Aggregate queries that power the admin dashboard. Every query in
// this file is read-only and pseudonymous — it operates on hashes
// + behavioural data only. Customer-level functions (recommendations
// etc.) live in customers.ts; this file holds the cohort-level views.

import { getDb } from "../db";
import type { AttributionModel } from "./attribution";

/** Count of customers per persona_tag across the system. Drives the
 *  pie/donut on the marketing overview. Includes a "(untagged)"
 *  bucket for customers with <2 visits. */
export function personaDistribution(args: {
  from?: string;       // optional — restrict to customers created in this window
  to?: string;
} = {}): Array<{ persona_tag: string; n: number }> {
  const where: string[] = [];
  const vals: Array<string> = [];
  if (args.from) { where.push("created_at >= ?"); vals.push(args.from); }
  if (args.to)   { where.push("created_at <= ?"); vals.push(args.to); }

  const rows = getDb().prepare(`
    SELECT COALESCE(persona_tag, '(untagged)') AS persona_tag, COUNT(*) AS n
    FROM insigna_customers
    ${where.length > 0 ? "WHERE " + where.join(" AND ") : ""}
    GROUP BY COALESCE(persona_tag, '(untagged)')
    ORDER BY n DESC
  `).all(...vals) as Array<{ persona_tag: string; n: number }>;
  return rows;
}

/** Cohort retention. Defines a cohort by acquisition_month and
 *  returns "% of cohort returning in month N" for the first 6
 *  months after acquisition. Classic dashboard view. */
export function cohortRetention(args: {
  cohort_month: string;        // 'YYYY-MM'
}): {
  cohort_size: number;
  retention: Array<{ month_offset: number; returning: number; pct: number }>;
} {
  const db = getDb();
  const [yyyy, mm] = args.cohort_month.split("-").map(Number);
  if (!yyyy || !mm) throw new Error("[INSIGNA] cohortRetention: cohort_month must be YYYY-MM");
  // Cohort = customers with first visit (== last_visit_at at the time)
  // in this calendar month, derived from earliest insigna_visits row.
  const cohortRows = db.prepare(`
    SELECT c.customer_hash,
           MIN(v.arrived_at) AS first_visit
    FROM insigna_customers c
    JOIN insigna_visits v ON v.customer_hash = c.customer_hash
    GROUP BY c.customer_hash
    HAVING strftime('%Y-%m', first_visit) = ?
  `).all(args.cohort_month) as Array<{ customer_hash: string; first_visit: string }>;

  const cohort_size = cohortRows.length;
  if (cohort_size === 0) {
    return { cohort_size: 0, retention: [] };
  }
  const hashes = cohortRows.map((r) => r.customer_hash);
  const placeholders = hashes.map(() => "?").join(",");

  const retention: Array<{ month_offset: number; returning: number; pct: number }> = [];
  for (let offset = 1; offset <= 6; offset++) {
    // Offset months ahead — count cohort members with any visit in
    // that calendar month.
    const targetDate = new Date(Date.UTC(yyyy, mm - 1 + offset, 1));
    const targetMonth = targetDate.toISOString().slice(0, 7);
    const returning = (db.prepare(`
      SELECT COUNT(DISTINCT v.customer_hash) AS n
      FROM insigna_visits v
      WHERE v.customer_hash IN (${placeholders})
        AND strftime('%Y-%m', v.arrived_at) = ?
    `).get(...hashes, targetMonth) as { n: number }).n;
    retention.push({
      month_offset: offset,
      returning,
      pct: Math.round((returning / cohort_size) * 1000) / 10  // 1dp percent
    });
  }
  return { cohort_size, retention };
}

/** Same as channelPerformance from attribution.ts, but the analytics
 *  surface re-exports it under the §4.7 endpoint name so consumers
 *  don't have to know about the lib split. */
export { channelPerformance } from "./attribution";

/** High-churn-risk read for outreach. Mirrors listHighChurnRisk
 *  with the §4.7 endpoint shape. */
export function churnRiskList(args: {
  threshold?: number;
  limit?: number;
} = {}): Array<{
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
  `).all(args.threshold ?? 0.5, args.limit ?? 100) as Array<{
    customer_hash: string;
    churn_risk_score: number;
    total_visits: number;
    last_visit_at: string | null;
    persona_tag: string | null;
  }>;
}

/** Marketing dashboard headline: total spend + revenue + ROAS for a
 *  window, broken down by channel. Reads from the precomputed
 *  daily_marketing_rollup table (Phase 13). */
export function marketingHeadline(args: {
  from: string;     // YYYY-MM-DD
  to: string;
  model?: AttributionModel;
}): {
  total_spend: number;
  total_revenue: number;
  total_new_customers: number;
  total_visits: number;
  blended_roas: number | null;
  blended_cac: number | null;
  by_channel: Array<{
    channel: string;
    spend: number;
    revenue: number;
    new_customers: number;
    visits: number;
    roas: number | null;
    cac: number | null;
  }>;
} {
  void args.model; // rollup is precomputed against a single configured default
  const rows = getDb().prepare(`
    SELECT channel,
           SUM(spend)         AS spend,
           SUM(revenue)       AS revenue,
           SUM(new_customers) AS new_customers,
           SUM(visits)        AS visits
    FROM insigna_daily_marketing_rollup
    WHERE rollup_date BETWEEN ? AND ?
    GROUP BY channel
    ORDER BY revenue DESC
  `).all(args.from, args.to) as Array<{
    channel: string; spend: number; revenue: number;
    new_customers: number; visits: number;
  }>;

  const by_channel = rows.map((r) => ({
    channel: r.channel,
    spend: r.spend,
    revenue: r.revenue,
    new_customers: r.new_customers,
    visits: r.visits,
    roas: r.spend > 0 ? r.revenue / r.spend : null,
    cac:  r.new_customers > 0 ? r.spend / r.new_customers : null
  }));

  const total_spend = rows.reduce((s, r) => s + r.spend, 0);
  const total_revenue = rows.reduce((s, r) => s + r.revenue, 0);
  const total_new_customers = rows.reduce((s, r) => s + r.new_customers, 0);
  const total_visits = rows.reduce((s, r) => s + r.visits, 0);

  return {
    total_spend, total_revenue, total_new_customers, total_visits,
    blended_roas: total_spend > 0 ? total_revenue / total_spend : null,
    blended_cac:  total_new_customers > 0 ? total_spend / total_new_customers : null,
    by_channel
  };
}
