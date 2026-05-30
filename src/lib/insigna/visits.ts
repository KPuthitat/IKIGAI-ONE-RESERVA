// INSIGNA — Visit lifecycle (spec section 4.4 — the critical handoff).
//
// "Visit" = one seating of one party. This is the unit of analysis
// for everything downstream: orders, feedback, persona inference,
// attribution. The booking system fires `startVisit` at the exact
// moment a customer is seated (per spec; in this codebase that
// corresponds to bookings.status flipping to 'seated' or the walk-in
// flow's "verify code" path).
//
// visit_token is a fresh random 32-char hex string per visit — NOT
// the bookings.id and NOT derived from it. A leaked visit_token
// reveals nothing about which booking row it shadows; you'd need
// the joined insigna_reservations row, which is itself
// pseudonymous.

import crypto from "node:crypto";
import { getDb } from "../db";
import { isCustomerHash } from "./hash";
import { logInsignaEvent } from "./audit";

export type PartyType = "SOLO" | "COUPLE" | "FAMILY" | "FRIENDS" | "BUSINESS" | "UNKNOWN";
export type TableZone = "INDOOR" | "OUTDOOR" | "BAR" | "WINDOW" | "PRIVATE";
export type MenuCategory = "APPETIZER" | "MAIN" | "PASTA" | "DESSERT" | "DRINK" | "WINE" | "OTHER";
export type MenuAction = "VIEWED" | "EXPANDED" | "ADDED" | "REMOVED";

type StartArgs = {
  reservation_id?: string | null;
  customer_hash: string;
  party_size: number;
  party_type: PartyType;
  table_id?: string | null;
  table_zone?: TableZone | null;
  visit_trigger_src?: string | null;
};

/** Open a new visit row. Returns the visit_token the caller stores
 *  next to its own bookings.id so subsequent calls (orders, menu
 *  interactions, end) can reference it. Marks the linked reservation
 *  COMPLETED in one transaction so the two side effects can't split. */
export function startVisit(args: StartArgs): { visit_token: string } {
  if (!isCustomerHash(args.customer_hash)) {
    throw new Error("[INSIGNA] startVisit: invalid customer_hash");
  }
  const visit_token = crypto.randomBytes(16).toString("hex");
  const db = getDb();
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO insigna_visits
        (visit_token, customer_hash, reservation_id, arrived_at,
         party_size, party_type, table_id, table_zone, visit_trigger_src)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      visit_token,
      args.customer_hash,
      args.reservation_id ?? null,
      now,
      args.party_size,
      args.party_type,
      args.table_id ?? null,
      args.table_zone ?? null,
      args.visit_trigger_src ?? null
    );

    if (args.reservation_id) {
      db.prepare(
        "UPDATE insigna_reservations SET status = 'COMPLETED' WHERE reservation_id = ?"
      ).run(args.reservation_id);
    }

    // Denormalised counters on the customer row. last_visit_at is
    // also used by churn detection so updating it here keeps the
    // signal fresh without a separate write.
    db.prepare(`
      UPDATE insigna_customers
      SET last_visit_at = ?,
          total_visits = total_visits + 1
      WHERE customer_hash = ?
    `).run(now, args.customer_hash);
  });
  tx();

  logInsignaEvent({
    event_type: "visit.start",
    customer_hash: args.customer_hash,
    payload: { visit_token, reservation_id: args.reservation_id ?? null }
  });

  return { visit_token };
}

type OrderInput = {
  menu_id: string;
  menu_name: string;
  category: MenuCategory;
  quantity: number;
  unit_price: number;
  special_request?: string | null;
};

/** Append order items to an open visit. The is_repeat_order flag is
 *  computed inline by checking prior order_items rows for the same
 *  customer + menu_id — cheap to do here, saves a separate job. */
export function addOrders(visit_token: string, items: OrderInput[]): void {
  const db = getDb();
  const customer_hash = (db.prepare(
    "SELECT customer_hash FROM insigna_visits WHERE visit_token = ?"
  ).get(visit_token) as { customer_hash: string } | undefined)?.customer_hash;
  if (!customer_hash) {
    throw new Error("[INSIGNA] addOrders: unknown visit_token");
  }

  // Pre-compute "did this customer order this menu_id before this
  // visit?" — one query against the union of menu_ids in this batch.
  const menuIds = [...new Set(items.map((i) => i.menu_id))];
  const placeholders = menuIds.map(() => "?").join(",");
  const priorRows = menuIds.length > 0
    ? (db.prepare(`
        SELECT DISTINCT oi.menu_id
        FROM insigna_order_items oi
        JOIN insigna_visits v ON v.visit_token = oi.visit_token
        WHERE v.customer_hash = ?
          AND v.visit_token <> ?
          AND oi.menu_id IN (${placeholders})
      `).all(customer_hash, visit_token, ...menuIds) as Array<{ menu_id: string }>)
    : [];
  const seen = new Set(priorRows.map((r) => r.menu_id));

  const tx = db.transaction(() => {
    const stmt = db.prepare(`
      INSERT INTO insigna_order_items
        (visit_token, menu_id, menu_name_snapshot, category,
         quantity, unit_price, special_request, is_repeat_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const it of items) {
      stmt.run(
        visit_token, it.menu_id, it.menu_name, it.category,
        it.quantity, it.unit_price, it.special_request ?? null,
        seen.has(it.menu_id) ? 1 : 0
      );
    }
  });
  tx();

  logInsignaEvent({
    event_type: "visit.orders",
    customer_hash,
    payload: { visit_token, count: items.length }
  });
}

type MenuInteractionInput = {
  menu_id: string;
  action: MenuAction;
  time_spent_sec?: number | null;
  ordered: boolean;
};

/** Append menu browse events (Phase 5 LIFF integration target). */
export function addMenuInteractions(
  visit_token: string,
  interactions: MenuInteractionInput[]
): void {
  const db = getDb();
  const tx = db.transaction(() => {
    const stmt = db.prepare(`
      INSERT INTO insigna_menu_interactions
        (visit_token, menu_id, action, time_spent_sec, ordered)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const e of interactions) {
      stmt.run(visit_token, e.menu_id, e.action, e.time_spent_sec ?? null, e.ordered ? 1 : 0);
    }
  });
  tx();

  logInsignaEvent({
    event_type: "visit.menu_interactions",
    payload: { visit_token, count: interactions.length }
  });
}

/** Close a visit. departedAt allowed to be in the past (admin
 *  forgot to stamp it earlier). Triggers downstream persona
 *  recalc + churn check jobs — those are stubbed for now and
 *  wired up in Phase 7-8 of the spec. */
export function endVisit(
  visit_token: string,
  departed_at?: string,
  staff_notes?: string | null
): void {
  const db = getDb();
  const row = db.prepare(
    "SELECT customer_hash FROM insigna_visits WHERE visit_token = ?"
  ).get(visit_token) as { customer_hash: string } | undefined;
  if (!row) {
    throw new Error("[INSIGNA] endVisit: unknown visit_token");
  }
  db.prepare(`
    UPDATE insigna_visits
    SET departed_at = ?, staff_notes = COALESCE(?, staff_notes)
    WHERE visit_token = ?
  `).run(departed_at ?? new Date().toISOString(), staff_notes ?? null, visit_token);

  logInsignaEvent({
    event_type: "visit.end",
    customer_hash: row.customer_hash,
    payload: { visit_token }
  });

  // Phase 7+8 hook (2026-05-30): recompute persona + churn for this
  // customer. Both are cheap (single-customer scope, no joins) so
  // running them inline keeps the data fresh without a separate
  // job. Errors are caught so a persona/churn computation failure
  // can never undo the visit close.
  try {
    // Dynamic import keeps the cycle clean: persona.ts and churn.ts
    // both depend on visit data we just wrote here, so we don't
    // want them in the top-level module graph of visits.ts.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { recomputePersonaTag } = require("./persona") as typeof import("./persona");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { recomputeChurnScore } = require("./churn") as typeof import("./churn");
    recomputePersonaTag(row.customer_hash);
    recomputeChurnScore(row.customer_hash);
  } catch (e) {
    console.warn("[insigna] post-visit recompute failed:", e);
  }
}
