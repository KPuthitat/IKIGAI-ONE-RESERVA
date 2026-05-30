// INSIGNA — Booking event bridge.
//
// Adapter the booking system uses to push events into INSIGNA. This
// is the ONLY file inside lib/insigna that accepts raw identifiers
// (LINE userId, phone) — the boundary hash happens here so the
// call site stays a one-liner and so all the "what if neither
// identifier is present" handling lives in one place.
//
// Every function in this file:
//   • Is fire-and-forget from the caller's POV (try/catch wraps
//     the body). A failed INSIGNA push MUST NOT break the booking
//     write — the wall doesn't justify breaking the source of truth.
//   • Logs warnings but never throws.
//   • No-ops when INSIGNA_SALT is unset (local dev, fresh deploy)
//     — the underlying hash module throws, we catch + warn once.

import {
  hashLineUserId,
  hashPhone,
  generateAnonymousHash
} from "./hash";
import { upsertCustomer } from "./customers";
import {
  syncReservation,
  updateReservationStatus,
  type ReservationChannel,
  type ReservationStatus
} from "./reservations";
import { startVisit, type PartyType } from "./visits";

/** Decide which customer_hash applies to this booking event.
 *  Precedence: LINE userId > phone > anonymous (per-visit one-shot).
 *  Returns null when even anonymous generation fails (i.e. INSIGNA
 *  is unconfigured — caller should silently skip). */
function deriveCustomerHash(args: {
  line_user_id?: string | null;
  phone?: string | null;
}): string | null {
  try {
    if (args.line_user_id && args.line_user_id.trim()) {
      return hashLineUserId(args.line_user_id.trim());
    }
    if (args.phone && args.phone.replace(/\D+/g, "").length >= 9) {
      return hashPhone(args.phone);
    }
    return generateAnonymousHash();
  } catch (e) {
    // The hash module throws when INSIGNA_SALT is unset; treat as
    // "INSIGNA disabled" and let the caller no-op. Log once per
    // process so a fresh deploy without the env var produces
    // visible noise without spamming.
    if (!warnedNoSalt) {
      console.warn("[insigna-bridge] hashing unavailable:", (e as Error).message);
      warnedNoSalt = true;
    }
    return null;
  }
}
let warnedNoSalt = false;

type BookingCreatedArgs = {
  /** booking_ref — the human-readable code admin sees. We use it as
   *  the reservation_id key so analytics joins against the booking
   *  side use a familiar value. */
  reservation_id: string;
  line_user_id?: string | null;
  phone?: string | null;
  booked_at: string;        // when the booking was created
  scheduled_at: string;     // when the customer is expected
  party_size: number;
  channel: ReservationChannel;
  special_occasion?: string | null;
  /** When this is true (walk-in, or admin-created with status='seated'),
   *  we also open a visit immediately. */
  status: "seated" | "confirmed" | "pending_review";
  /** Optional onboarding hints — only the first non-null reaches
   *  insigna_customers.acquisition_source. */
  acquisition_source?: string | null;
  acquisition_campaign?: string | null;
  /** Visit-only fields (used when status === 'seated'). */
  table_id?: string | null;
  table_zone?: "INDOOR" | "OUTDOOR" | "BAR" | "WINDOW" | "PRIVATE" | null;
  party_type?: PartyType;
};

/** Push a "booking just got created" event into INSIGNA.
 *  Returns the visit_token when one was opened (status='seated'),
 *  null otherwise. Errors are caught + warned. */
export function onBookingCreated(args: BookingCreatedArgs): {
  customer_hash: string | null;
  visit_token: string | null;
} {
  try {
    const customer_hash = deriveCustomerHash({
      line_user_id: args.line_user_id,
      phone: args.phone
    });
    if (!customer_hash) {
      return { customer_hash: null, visit_token: null };
    }

    upsertCustomer({
      customer_hash,
      consent_marketing: false, // default off; flipped via admin / consent banner
      consent_analytics: true,  // analytics is opt-out by default (banner gates this)
      acquisition_source: args.acquisition_source ?? null,
      acquisition_campaign: args.acquisition_campaign ?? null
    });

    syncReservation({
      reservation_id: args.reservation_id,
      customer_hash,
      booked_at: args.booked_at,
      scheduled_at: args.scheduled_at,
      party_size: args.party_size,
      channel: args.channel,
      special_occasion: args.special_occasion ?? null
    });

    let visit_token: string | null = null;
    if (args.status === "seated") {
      const v = startVisit({
        reservation_id: args.reservation_id,
        customer_hash,
        party_size: args.party_size,
        party_type: args.party_type ?? "UNKNOWN",
        table_id: args.table_id ?? null,
        table_zone: args.table_zone ?? null
      });
      visit_token = v.visit_token;
    }

    return { customer_hash, visit_token };
  } catch (e) {
    console.warn("[insigna-bridge] onBookingCreated failed:", e);
    return { customer_hash: null, visit_token: null };
  }
}

type StatusChangeArgs = {
  reservation_id: string;
  /** booking-side new status — we translate to INSIGNA's enum. */
  new_status: "confirmed" | "seated" | "no_show" | "cancelled" | "completed" | "pending_review";
  /** Required ONLY when new_status === 'seated' and there isn't
   *  already an INSIGNA visit for this reservation (i.e. the
   *  customer was confirmed first, then admin marks seated later). */
  visit_args?: {
    customer_hash: string;
    party_size: number;
    party_type?: PartyType;
    table_id?: string | null;
    table_zone?: "INDOOR" | "OUTDOOR" | "BAR" | "WINDOW" | "PRIVATE" | null;
  };
};

/** Push a "booking status changed" event. Translates the booking
 *  status enum to INSIGNA's narrower one (CONFIRMED, CANCELLED,
 *  NOSHOW, COMPLETED). 'pending_review' has no INSIGNA mapping —
 *  reservations don't enter the shadow table until they're at
 *  least CONFIRMED, so this is a no-op. */
export function onBookingStatusChanged(args: StatusChangeArgs): void {
  try {
    const map: Record<string, ReservationStatus | null> = {
      confirmed: "CONFIRMED",
      seated:    "COMPLETED",  // seating completes the reservation
      completed: "COMPLETED",
      no_show:   "NOSHOW",
      cancelled: "CANCELLED",
      pending_review: null
    };
    const target = map[args.new_status];
    if (!target) return;
    updateReservationStatus(args.reservation_id, target);

    // If the status JUST flipped to seated and the caller has visit
    // metadata, open a visit too.
    if (args.new_status === "seated" && args.visit_args) {
      startVisit({
        reservation_id: args.reservation_id,
        ...args.visit_args,
        party_type: args.visit_args.party_type ?? "UNKNOWN"
      });
    }
  } catch (e) {
    console.warn("[insigna-bridge] onBookingStatusChanged failed:", e);
  }
}
