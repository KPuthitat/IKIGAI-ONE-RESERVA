import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, type Booking, type Branch } from "@/lib/db";
import { notifyCustomer } from "@/lib/line";

// POST /api/bookings/claim
//
// Lets a customer "claim" a booking that admin entered on their behalf via
// the +จองผ่านไลน์ modal. Workflow:
//   1. Admin saves a 'line' booking with no line_user_id (default flow)
//   2. Admin sends the customer a /r/<ref>/claim link in the LINE OA chat
//   3. Customer taps the link → ClaimClient initializes LIFF → captures
//      the LINE userId silently → POSTs here
//   4. Server saves the userId on the booking and pushes the Flex
//      confirmation card with QR
//
// Idempotency: re-posting with the same ref+userId is a no-op (returns
// already_linked). Posting with a different userId on an already-claimed
// booking is rejected to prevent stranger-takeover. The link itself is
// trusted because it's shared 1:1 from admin to customer in the OA chat.
//
// Public endpoint (no admin auth) — the claim link is the only credential.

const Body = z.object({
  ref: z.string().regex(/^R\d{10,12}$/),     // R + YYYYMM + 4-5 digit seq
  line_user_id: z.string().min(8).max(64)
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { ref, line_user_id } = parsed.data;

  const db = getDb();
  const booking = db.prepare("SELECT * FROM bookings WHERE ref_no = ?")
    .get(ref) as Booking | undefined;
  if (!booking) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Reject claims on terminal-state bookings — nothing useful happens after
  // sending a Flex card to a cancelled / completed booking, and it confuses
  // the customer.
  if (booking.status === "cancelled" || booking.status === "completed") {
    return NextResponse.json({ error: "booking_closed" }, { status: 410 });
  }

  // Already linked → idempotent if same user, reject if different user.
  if (booking.line_user_id) {
    if (booking.line_user_id === line_user_id) {
      return NextResponse.json({ ok: true, already_linked: true });
    }
    return NextResponse.json({ error: "already_claimed" }, { status: 409 });
  }

  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(booking.branch_id) as Branch | undefined;
  if (!branch) return NextResponse.json({ error: "branch_not_found" }, { status: 404 });

  // Save the userId
  db.prepare("UPDATE bookings SET line_user_id = ?, updated_at = ? WHERE id = ?")
    .run(line_user_id, new Date().toISOString(), booking.id);

  const updated = db.prepare("SELECT * FROM bookings WHERE id = ?")
    .get(booking.id) as Booking;

  // Push the confirmation Flex card. notifyCustomer skips silently if the
  // branch has no channel token configured — claim still counts as success
  // because the userId is now on the booking and reminders will work.
  notifyCustomer(branch, updated, "created").catch((e) =>
    console.error("notify error after claim", e)
  );

  return NextResponse.json({ ok: true, status: updated.status });
}
