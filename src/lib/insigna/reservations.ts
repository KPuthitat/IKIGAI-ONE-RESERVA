// INSIGNA — Reservation shadow records (spec section 4.3).
//
// The real reservation lives in the booking system's `bookings`
// table with all the PII (name, phone, line_user_id, etc.). What
// INSIGNA mirrors here is the analytics-relevant subset: who
// (pseudonymously), when, what size, what channel, what status.
// Mutations are pushed from booking; INSIGNA never pulls back.
//
// reservation_id is the same opaque token used in the booking
// system but treated as a string token here — we do not reuse it
// to query the bookings table (that would breach the wall).

import { getDb } from "../db";
import { isCustomerHash } from "./hash";
import { logInsignaEvent } from "./audit";

export type ReservationChannel = "LINE" | "WALKIN" | "PARTNER" | "PHONE";
export type ReservationStatus = "CONFIRMED" | "CANCELLED" | "NOSHOW" | "COMPLETED";

type SyncArgs = {
  reservation_id: string;
  customer_hash: string;
  booked_at: string;        // ISO
  scheduled_at: string;     // ISO
  party_size: number;
  channel: ReservationChannel;
  special_occasion?: string | null;
};

/** Upsert a shadow reservation. Called by the booking flow whenever
 *  a reservation is created OR a key detail (party_size, scheduled
 *  time, special_occasion) changes. modified_count auto-increments
 *  on every overwrite so analytics can spot "high-churn" reservations
 *  (lots of date changes → flaky customer or operator entry errors). */
export function syncReservation(args: SyncArgs): void {
  if (!isCustomerHash(args.customer_hash)) {
    throw new Error("[INSIGNA] syncReservation: invalid customer_hash");
  }
  const db = getDb();
  const existing = db.prepare(
    "SELECT modified_count FROM insigna_reservations WHERE reservation_id = ?"
  ).get(args.reservation_id) as { modified_count: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE insigna_reservations
      SET customer_hash = ?, booked_at = ?, scheduled_at = ?,
          party_size = ?, channel = ?, special_occasion = ?,
          modified_count = modified_count + 1
      WHERE reservation_id = ?
    `).run(
      args.customer_hash, args.booked_at, args.scheduled_at,
      args.party_size, args.channel, args.special_occasion ?? null,
      args.reservation_id
    );
  } else {
    db.prepare(`
      INSERT INTO insigna_reservations
        (reservation_id, customer_hash, booked_at, scheduled_at,
         party_size, channel, status, special_occasion, modified_count)
      VALUES (?, ?, ?, ?, ?, ?, 'CONFIRMED', ?, 0)
    `).run(
      args.reservation_id, args.customer_hash, args.booked_at,
      args.scheduled_at, args.party_size, args.channel,
      args.special_occasion ?? null
    );
  }

  logInsignaEvent({
    event_type: existing ? "reservation.update" : "reservation.create",
    customer_hash: args.customer_hash,
    payload: { reservation_id: args.reservation_id }
  });
}

/** Status transitions for the shadow reservation. Called when the
 *  booking system flips its status (admin cancels, no-show stamp,
 *  customer-arrived completes). 'COMPLETED' is also set automatically
 *  inside visits.startVisit when the visit links to a reservation —
 *  callers don't need to fire this for the happy path. */
export function updateReservationStatus(
  reservation_id: string,
  status: ReservationStatus
): void {
  getDb().prepare(
    "UPDATE insigna_reservations SET status = ? WHERE reservation_id = ?"
  ).run(status, reservation_id);

  const row = getDb().prepare(
    "SELECT customer_hash FROM insigna_reservations WHERE reservation_id = ?"
  ).get(reservation_id) as { customer_hash: string } | undefined;

  logInsignaEvent({
    event_type: "reservation.status",
    customer_hash: row?.customer_hash ?? null,
    payload: { reservation_id, status }
  });
}
