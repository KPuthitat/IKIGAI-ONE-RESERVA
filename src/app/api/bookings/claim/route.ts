import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, type Booking, type Branch } from "@/lib/db";
import { notifyCustomer } from "@/lib/line";

// POST /api/bookings/claim
//
// Lets a customer "claim" a booking that admin entered on their behalf via
// the +จองผ่านไลน์ modal. Now also captures optional marketing answers
// (origin / source / is_member) the customer fills on the claim page —
// admin can't know these when entering the booking on the customer's
// behalf, so the claim screen is the natural place to ask.
//
// Workflow:
//   1. Admin saves a 'line' booking with no line_user_id
//   2. Admin sends the customer a /reserva/<branch>/claim/<ref> link
//   3. Customer taps → ClaimClient → silent LIFF login → captures userId
//   4. Customer optionally fills marketing chips → taps "Confirm"
//   5. POST here → save userId + marketing fields → push Flex card
//
// Idempotency: re-posting with the same ref+userId is a no-op (returns
// already_linked). Posting with a different userId on an already-claimed
// booking is rejected to prevent stranger-takeover. Marketing fields
// are merged: passed values overwrite, omitted/null values leave the
// existing column unchanged.
//
// Public endpoint (no admin auth) — the claim link is the only credential.

const Body = z.object({
  ref: z.string().regex(/^R\d{10,12}$/),     // R + YYYYMM + 4-5 digit seq
  line_user_id: z.string().min(8).max(64),
  // Optional marketing fields — customer may skip them entirely. Keys
  // mirror /api/bookings so the same chip values flow through both flows.
  customer_origin: z.string().max(50).nullish(),
  source: z.string().max(200).nullish(),     // JSON-stringified array OR plain string
  is_member: z.union([z.literal(0), z.literal(1)]).nullish()
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { ref, line_user_id, customer_origin, source, is_member } = parsed.data;

  const db = getDb();
  const booking = db.prepare("SELECT * FROM bookings WHERE ref_no = ?")
    .get(ref) as Booking | undefined;
  if (!booking) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Reject claims on terminal-state bookings.
  if (booking.status === "cancelled" || booking.status === "completed") {
    return NextResponse.json({ error: "booking_closed" }, { status: 410 });
  }

  // Already linked → idempotent if same user, reject if different user.
  if (booking.line_user_id) {
    if (booking.line_user_id === line_user_id) {
      // Even on already-linked, if the customer added marketing answers
      // this time round, store them. (They might tap "confirm" again
      // after answering — friendly to capture data twice.)
      maybeUpdateMarketing(booking.id, { customer_origin, source, is_member });
      return NextResponse.json({ ok: true, already_linked: true });
    }
    return NextResponse.json({ error: "already_claimed" }, { status: 409 });
  }

  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(booking.branch_id) as Branch | undefined;
  if (!branch) return NextResponse.json({ error: "branch_not_found" }, { status: 404 });

  // Save the userId AND any marketing fields in one transaction so the
  // booking row reflects everything before the Flex push (the card body
  // could include the marketing fields someday).
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE bookings
    SET line_user_id = ?,
        customer_origin = COALESCE(?, customer_origin),
        source = COALESCE(?, source),
        is_member = COALESCE(?, is_member),
        updated_at = ?
    WHERE id = ?
  `).run(
    line_user_id,
    customer_origin ?? null,
    source ?? null,
    is_member ?? null,
    now,
    booking.id
  );

  const updated = db.prepare("SELECT * FROM bookings WHERE id = ?")
    .get(booking.id) as Booking;

  // Push the confirmation Flex card. Skipped silently if the branch has
  // no channel token configured.
  notifyCustomer(branch, updated, "created").catch((e) =>
    console.error("notify error after claim", e)
  );

  return NextResponse.json({ ok: true, status: updated.status });
}

// Helper for the already-linked, same-user case — only writes columns the
// customer actually filled (avoids clobbering admin-entered data with NULL).
function maybeUpdateMarketing(
  bookingId: number,
  fields: {
    customer_origin?: string | null;
    source?: string | null;
    is_member?: 0 | 1 | null;
  }
): void {
  const sets: string[] = [];
  const vals: Array<string | number | null> = [];
  if (fields.customer_origin) {
    sets.push("customer_origin = ?");
    vals.push(fields.customer_origin);
  }
  if (fields.source) {
    sets.push("source = ?");
    vals.push(fields.source);
  }
  if (fields.is_member === 0 || fields.is_member === 1) {
    sets.push("is_member = ?");
    vals.push(fields.is_member);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  vals.push(new Date().toISOString());
  vals.push(bookingId);
  getDb().prepare(`UPDATE bookings SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}
