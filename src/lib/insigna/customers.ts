// INSIGNA — Customer service (spec section 4.2).
//
// Pseudonymous customer profile upsert + retrieval + GDPR-style
// delete. Callers pass a pre-computed customer_hash; this module
// NEVER receives a raw LINE userId or phone. The hash boundary
// lives in lib/insigna/hash.ts; calling sites in booking code
// should compute the hash there immediately before calling these
// functions so the identifier stays on the booking side of the
// wall.

import { getDb } from "../db";
import { isCustomerHash } from "./hash";
import { logInsignaEvent } from "./audit";

export type InsignaCustomer = {
  customer_hash: string;
  birth_year: number | null;
  gender: "M" | "F" | "X" | null;
  consent_marketing: number;
  consent_analytics: number;
  acquisition_source: string | null;
  acquisition_campaign: string | null;
  acquisition_date: string | null;
  created_at: string;
  last_visit_at: string | null;
  total_visits: number;
  persona_tag: string | null;
  churn_risk_score: number;
};

type UpsertArgs = {
  customer_hash: string;
  birth_year?: number | null;
  gender?: "M" | "F" | "X" | null;
  consent_marketing?: boolean;
  consent_analytics?: boolean;
  acquisition_source?: string | null;
  acquisition_campaign?: string | null;
};

/** Insert a new pseudonymous customer or update the existing one
 *  with whatever fields are provided. Missing fields preserve the
 *  current value (matches the spec's "patch semantics" implied by
 *  upsert). Returns the resulting row.
 *
 *  CRITICAL: only pass a customer_hash output from lib/insigna/hash
 *  — passing a LINE userId directly would write PII to INSIGNA. */
export function upsertCustomer(args: UpsertArgs): InsignaCustomer {
  if (!isCustomerHash(args.customer_hash)) {
    throw new Error("[INSIGNA] upsertCustomer: customer_hash must be 64-char hex");
  }
  const db = getDb();
  const existing = db.prepare(
    "SELECT * FROM insigna_customers WHERE customer_hash = ?"
  ).get(args.customer_hash) as InsignaCustomer | undefined;

  if (!existing) {
    db.prepare(`
      INSERT INTO insigna_customers
        (customer_hash, birth_year, gender, consent_marketing, consent_analytics,
         acquisition_source, acquisition_campaign, acquisition_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      args.customer_hash,
      args.birth_year ?? null,
      args.gender ?? null,
      args.consent_marketing ? 1 : 0,
      args.consent_analytics ? 1 : 0,
      args.acquisition_source ?? null,
      args.acquisition_campaign ?? null,
      args.acquisition_source ? new Date().toISOString() : null
    );
  } else {
    // Patch only the keys the caller passed — preserves any prior
    // consent flips, demographic fills, etc. acquisition_* updates
    // ONLY when previously null (first-touch sticks; we don't
    // overwrite the original source with a later one).
    const sets: string[] = [];
    const vals: Array<string | number | null> = [];
    if (args.birth_year !== undefined) {
      sets.push("birth_year = ?"); vals.push(args.birth_year);
    }
    if (args.gender !== undefined) {
      sets.push("gender = ?"); vals.push(args.gender);
    }
    if (args.consent_marketing !== undefined) {
      sets.push("consent_marketing = ?"); vals.push(args.consent_marketing ? 1 : 0);
    }
    if (args.consent_analytics !== undefined) {
      sets.push("consent_analytics = ?"); vals.push(args.consent_analytics ? 1 : 0);
    }
    if (args.acquisition_source && existing.acquisition_source == null) {
      sets.push("acquisition_source = ?", "acquisition_campaign = ?", "acquisition_date = ?");
      vals.push(args.acquisition_source, args.acquisition_campaign ?? null, new Date().toISOString());
    }
    if (sets.length > 0) {
      vals.push(args.customer_hash);
      db.prepare(`UPDATE insigna_customers SET ${sets.join(", ")} WHERE customer_hash = ?`).run(...vals);
    }
  }

  logInsignaEvent({
    event_type: "customer.upsert",
    customer_hash: args.customer_hash,
    payload: { fields: Object.keys(args).filter((k) => k !== "customer_hash") }
  });

  return db.prepare(
    "SELECT * FROM insigna_customers WHERE customer_hash = ?"
  ).get(args.customer_hash) as InsignaCustomer;
}

/** Pull the pseudonymous profile. Returns null if the hash isn't
 *  registered — callers (staff pre-visit briefing) should treat
 *  that as "new customer, no priors". */
export function getCustomerProfile(hash: string): InsignaCustomer | null {
  if (!isCustomerHash(hash)) return null;
  const row = getDb().prepare(
    "SELECT * FROM insigna_customers WHERE customer_hash = ?"
  ).get(hash) as InsignaCustomer | undefined;
  return row ?? null;
}

/** Right to be forgotten (spec section 6.7). Cascade DELETE relies
 *  on the FK ON DELETE CASCADE chain set up in db.ts — visits,
 *  order_items, menu_interactions, feedback, tags, touchpoints,
 *  attribution_ledger rows all go with the customer. Returns the
 *  per-table delete counts so the caller can confirm completeness. */
export function deleteCustomer(hash: string): {
  customers: number;
  reservations: number;
  visits: number;
  order_items: number;
  menu_interactions: number;
  feedback: number;
  tags: number;
  touchpoints: number;
  attribution_rows: number;
  referrals: number;
} {
  if (!isCustomerHash(hash)) {
    throw new Error("[INSIGNA] deleteCustomer: invalid hash");
  }
  const db = getDb();
  // Count first (cascade deletes leave no trace to count after).
  const c = (table: string, col: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(hash) as { n: number }).n;
  const counts = {
    customers: 1,
    reservations: c("insigna_reservations", "customer_hash"),
    visits: c("insigna_visits", "customer_hash"),
    order_items: (db.prepare(
      `SELECT COUNT(*) AS n FROM insigna_order_items oi
       JOIN insigna_visits v ON v.visit_token = oi.visit_token
       WHERE v.customer_hash = ?`
    ).get(hash) as { n: number }).n,
    menu_interactions: (db.prepare(
      `SELECT COUNT(*) AS n FROM insigna_menu_interactions mi
       JOIN insigna_visits v ON v.visit_token = mi.visit_token
       WHERE v.customer_hash = ?`
    ).get(hash) as { n: number }).n,
    feedback: (db.prepare(
      `SELECT COUNT(*) AS n FROM insigna_feedback f
       JOIN insigna_visits v ON v.visit_token = f.visit_token
       WHERE v.customer_hash = ?`
    ).get(hash) as { n: number }).n,
    tags: c("insigna_customer_tags", "customer_hash"),
    touchpoints: c("insigna_campaign_touchpoints", "customer_hash"),
    attribution_rows: (db.prepare(
      `SELECT COUNT(*) AS n FROM insigna_attribution_ledger al
       JOIN insigna_visits v ON v.visit_token = al.visit_token
       WHERE v.customer_hash = ?`
    ).get(hash) as { n: number }).n,
    referrals: c("insigna_referral_codes", "owner_customer_hash")
  };
  // FK ON DELETE CASCADE handles every downstream row in one statement.
  // Pragma enable foreign_keys is already on for the project.
  db.prepare("DELETE FROM insigna_customers WHERE customer_hash = ?").run(hash);
  logInsignaEvent({
    event_type: "customer.delete",
    customer_hash: hash,
    payload: counts
  });
  return counts;
}
