import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, type Booking, type Branch } from "@/lib/db";
import { isTableFree } from "@/lib/table-allocator";
import { notifyCustomer } from "@/lib/line";

// POST /api/admin/bookings/[id]/confirm
//
// Promotes a 'pending_review' booking to 'confirmed' after the admin has
// assigned a table. This is the second step of the two-step customer flow:
//   1. Customer submits via /reserva/[branch] → status='pending_review'
//   2. Admin opens the bookings list, picks a table from the dropdown,
//      then clicks "Confirm and notify" which calls this endpoint.
//
// Side-effects:
//   - sets table_id (validated against double-booking)
//   - sets status='confirmed'
//   - pushes the customer Flex card with QR (if line_user_id is on file)
//   - records the customer-card send in notification_log
//
// The endpoint is idempotent only inasmuch as re-calling on an already-
// confirmed booking will re-send the Flex card. UI guards against this by
// hiding the button after confirm. We don't enforce the status='pending'
// precondition strictly — admin may want to use this to re-send the card
// after editing the table.

// table_id is optional now that the floor-plan / table-assignment step
// has been shelved. When omitted, the booking is confirmed (and the
// customer card sent) WITHOUT touching table_id — so any table that was
// set stays, and table-less bookings just confirm straight through.
const Body = z.object({
  table_id: z.number().int().positive().nullable().optional()
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const db = getDb();
  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id) as Booking | undefined;
  if (!booking) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!userHasBranch(user, booking.branch_id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const now = new Date().toISOString();
  // Owner direction 2026-05: confirming a booking without a table is
  // a hard error. Customer was complaining that the Flex card landed
  // with no seat assigned — they walked in expecting a table and we
  // had nothing for them. The body MAY omit table_id when the booking
  // row already has one (admin pre-assigned via the table dropdown),
  // but the final state MUST have a table set.
  const effectiveTableId = parsed.data.table_id ?? booking.table_id ?? null;
  if (effectiveTableId == null) {
    return NextResponse.json({ error: "table_required" }, { status: 400 });
  }
  if (parsed.data.table_id != null) {
    // A table was explicitly chosen — double-booking race guard then
    // set table + confirm.
    const free = isTableFree({
      branchId: booking.branch_id,
      tableId: parsed.data.table_id,
      date: booking.booking_date,
      time: booking.booking_time,
      durationMinutes: booking.duration_minutes,
      excludeBookingId: booking.id
    });
    if (!free) {
      return NextResponse.json({ error: "table_unavailable" }, { status: 409 });
    }
    db.prepare(`
      UPDATE bookings SET table_id = ?, status = 'confirmed', updated_at = ?
      WHERE id = ?
    `).run(parsed.data.table_id, now, id);
  } else {
    // No table in body but the row already has one — just flip status.
    db.prepare(`
      UPDATE bookings SET status = 'confirmed', updated_at = ?
      WHERE id = ?
    `).run(now, id);
  }

  // Re-fetch with the updated table_id so notifyCustomer sees the new
  // table on the booking row (the Flex card includes table label).
  const updated = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id) as Booking;
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?").get(updated.branch_id) as Branch | undefined;
  if (!branch) return NextResponse.json({ error: "branch_not_found" }, { status: 404 });

  // Fire the customer Flex card. Skipped silently if line_user_id is null
  // (e.g., booking was entered by phone with no LINE binding) — admin
  // would need to follow up via SMS/call in that case.
  notifyCustomer(branch, updated, "created").catch((e) => console.error("notify error", e));

  return NextResponse.json({ ok: true, status: "confirmed" });
}
