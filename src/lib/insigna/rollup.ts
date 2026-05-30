// INSIGNA — Daily marketing rollup (spec §5.4).
//
// Nightly job: for the previous calendar day in Bangkok, compute per
// channel: spend, new_customers, visits, revenue, roas, cac. Upsert
// into insigna_daily_marketing_rollup so the analytics endpoint can
// serve months-of-data dashboard reads from one indexed table.
//
// Idempotent: rerunning the same date overwrites the existing row
// for that (date, channel) tuple (UNIQUE constraint + ON CONFLICT).
// Useful when an ad-platform spend import lands late and we need
// to refresh yesterday's row.

import { getDb } from "../db";
import type { AttributionModel } from "./attribution";

/** Compute one day. dateBkk is "YYYY-MM-DD" in Bangkok local. The
 *  rollup attribution model defaults to first_touch (spec implies
 *  "configured default"; first_touch is the most defensible single
 *  choice for restaurant where a customer often hears about us once
 *  and then comes much later). */
export function rollupDay(
  dateBkk: string,
  attribution_model: AttributionModel = "first_touch"
): {
  date: string;
  rows_written: number;
} {
  const db = getDb();
  // Bangkok-day → UTC instants for the visit / customer joins.
  // 00:00 ICT = 17:00 UTC previous day; 23:59:59 ICT = 16:59:59 UTC same day.
  const dayStart = new Date(`${dateBkk}T00:00:00+07:00`).toISOString();
  const dayEnd   = new Date(`${dateBkk}T23:59:59.999+07:00`).toISOString();

  // Pull every channel that has activity OR spend on this day so we
  // never lose a channel with spend > 0 + revenue 0 (still a valid
  // data point — show "you spent X and got nothing back").
  const channels = db.prepare(`
    SELECT DISTINCT channel
    FROM (
      SELECT channel FROM insigna_marketing_campaigns
      WHERE actual_spend > 0
        AND (end_date IS NULL OR end_date >= ?)
        AND start_date <= ?
      UNION
      SELECT channel FROM insigna_attribution_ledger al
      JOIN insigna_visits v ON v.visit_token = al.visit_token
      WHERE v.arrived_at BETWEEN ? AND ?
    )
    WHERE channel IS NOT NULL AND channel <> ''
  `).all(dateBkk, dateBkk, dayStart, dayEnd) as Array<{ channel: string }>;

  let rows_written = 0;

  for (const { channel } of channels) {
    // Spend on this channel today. Naive approach: spend per day =
    // actual_spend * (1 / campaign_active_days). A future enhancement
    // would import per-day spend rows from ad platforms directly;
    // for Phase 13 the prorate is sufficient.
    const spendRow = db.prepare(`
      SELECT campaign_id, actual_spend, start_date, end_date
      FROM insigna_marketing_campaigns
      WHERE channel = ?
        AND start_date <= ?
        AND (end_date IS NULL OR end_date >= ?)
    `).all(channel, dateBkk, dateBkk) as Array<{
      campaign_id: string; actual_spend: number;
      start_date: string; end_date: string | null;
    }>;

    let spend = 0;
    for (const row of spendRow) {
      const start = new Date(row.start_date).getTime();
      const end = row.end_date
        ? new Date(row.end_date).getTime()
        : new Date(dateBkk).getTime();
      const days = Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1);
      spend += row.actual_spend / days;
    }
    spend = Math.round(spend * 100) / 100;

    // New customers acquired on this channel today.
    const new_customers = (db.prepare(`
      SELECT COUNT(*) AS n FROM insigna_customers
      WHERE acquisition_date BETWEEN ? AND ?
        AND acquisition_source = ?
    `).get(dayStart, dayEnd, channel) as { n: number }).n;

    // Visits attributed to this channel today (per chosen model).
    const visitsRow = db.prepare(`
      SELECT COUNT(DISTINCT al.visit_token) AS visits,
             COALESCE(SUM(al.attributed_revenue), 0) AS revenue
      FROM insigna_attribution_ledger al
      JOIN insigna_visits v ON v.visit_token = al.visit_token
      WHERE al.channel = ?
        AND al.attribution_model = ?
        AND v.arrived_at BETWEEN ? AND ?
    `).get(channel, attribution_model, dayStart, dayEnd) as {
      visits: number; revenue: number;
    };

    const revenue = Math.round(visitsRow.revenue * 100) / 100;
    const roas = spend > 0 ? Math.round((revenue / spend) * 100) / 100 : null;
    const cac  = new_customers > 0 ? Math.round((spend / new_customers) * 100) / 100 : null;

    db.prepare(`
      INSERT INTO insigna_daily_marketing_rollup
        (rollup_date, channel, spend, new_customers, visits, revenue, roas, cac)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(rollup_date, channel) DO UPDATE SET
        spend = excluded.spend,
        new_customers = excluded.new_customers,
        visits = excluded.visits,
        revenue = excluded.revenue,
        roas = excluded.roas,
        cac = excluded.cac,
        computed_at = CURRENT_TIMESTAMP
    `).run(dateBkk, channel, spend, new_customers, visitsRow.visits, revenue, roas, cac);

    rows_written += 1;
  }

  return { date: dateBkk, rows_written };
}

/** Convenience for the cron: compute YESTERDAY (Bangkok). The
 *  caller (the cron handler) wraps this in its own try/catch and
 *  log so a single-day computation error doesn't kill the whole
 *  schedule. */
export function rollupYesterday(model?: AttributionModel): {
  date: string;
  rows_written: number;
} {
  const nowBkk = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const y = new Date(Date.UTC(nowBkk.getUTCFullYear(), nowBkk.getUTCMonth(), nowBkk.getUTCDate() - 1));
  const dateBkk = y.toISOString().slice(0, 10);
  return rollupDay(dateBkk, model);
}
