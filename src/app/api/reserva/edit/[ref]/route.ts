// PATCH /api/reserva/edit/[ref]
//
// Customer-facing endpoint to modify or cancel an existing booking via
// the LINE Flex card link. Knowledge of the ref ('R20260500001') is the
// only auth — these refs are not enumerable (10-digit suffix per month
// per branch family) so this is acceptable risk for a low-volume booking
// system. Anyone with the customer's LINE chat can already see the ref.
//
// Two modes via the body:
//   { action: 'cancel' }                                  → status='cancelled'
//   { party_size, booking_date, booking_time, notes }     → modify
//
// Both modes enforce the 2-hour cutoff: editing or cancelling within
// 2 hours of booking_time is rejected (the customer must call the
// restaurant directly at that point).

import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, type Booking, type Branch } from "@/lib/db";
import { isTableFree } from "@/lib/table-allocator";
import { isBookingRef } from "@/lib/reserva-ref";
import { notifyStaff } from "@/lib/line";

// Match the page-side constant. See /reserva/edit/[ref]/page.tsx for
// why we settled on 60 min.
const EDIT_CUTOFF_MINUTES = 60;

const Body = z.union([
  z.object({ action: z.literal("cancel") }),
  z.object({
    action: z.undefined().optional(),
    party_size: z.number().int().min(1).max(50).optional(),
    booking_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    booking_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    notes: z.string().max(500).optional()
  })
]);

export async function PATCH(req: Request, { params }: { params: { ref: string } }) {
  const ref = decodeURIComponent(params.ref ?? "");
  if (!isBookingRef(ref)) {
    return NextResponse.json({ error: "invalid_ref" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }

  const db = getDb();
  const booking = db.prepare("SELECT * FROM bookings WHERE ref_no = ?").get(ref) as Booking | undefined;
  if (!booking) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (booking.status === "cancelled") {
    return NextResponse.json({ error: "already_cancelled" }, { status: 409 });
  }

  // Enforce the 2-hour cutoff (server is the authority — UI guards are
  // best-effort but this is what actually matters)
  const bookingTs = new Date(`${booking.booking_date}T${booking.booking_time}:00+07:00`).getTime();
  const minutesUntil = Math.floor((bookingTs - Date.now()) / 60000);
  if (minutesUntil < EDIT_CUTOFF_MINUTES) {
    return NextResponse.json({ error: "edit_window_closed" }, { status: 403 });
  }

  // ── Cancel branch ───────────────────────────────────────────────
  if ("action" in parsed.data && parsed.data.action === "cancel") {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE bookings SET status='cancelled', cancelled_at=?, updated_at=?
      WHERE id=?
    `).run(now, now, booking.id);
    return NextResponse.json({ ok: true, action: "cancelled" });
  }

  // ── Modify branch ───────────────────────────────────────────────
  const d = parsed.data as Exclude<typeof parsed.data, { action: "cancel" }>;
  const newDate = d.booking_date ?? booking.booking_date;
  const newTime = d.booking_time ?? booking.booking_time;
  const newSize = d.party_size ?? booking.party_size;
  const newNotes = d.notes !== undefined ? d.notes : booking.notes;

  // If date/time/size changed and a table was assigned, re-check
  // availability under the new slot.
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(booking.branch_id) as Branch | undefined;
  if (!branch) return NextResponse.json({ error: "branch_not_found" }, { status: 500 });

  const dateChanged = newDate !== booking.booking_date;
  const timeChanged = newTime !== booking.booking_time;
  if (booking.table_id && (dateChanged || timeChanged)) {
    const free = isTableFree({
      branchId: booking.branch_id,
      tableId: booking.table_id,
      date: newDate,
      time: newTime,
      durationMinutes: branch.default_duration_minutes,
      excludeBookingId: booking.id
    });
    if (!free) {
      return NextResponse.json({ error: "table_unavailable" }, { status: 409 });
    }
  }

  // Validate the new date isn't in the past
  const newBookingTs = new Date(`${newDate}T${newTime}:00+07:00`).getTime();
  if (newBookingTs - Date.now() < EDIT_CUTOFF_MINUTES * 60 * 1000) {
    // The new slot itself violates the cutoff (customer trying to move
    // the booking too close to now)
    return NextResponse.json({ error: "edit_window_closed" }, { status: 403 });
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE bookings
    SET party_size=?, booking_date=?, booking_time=?, notes=?, updated_at=?
    WHERE id=?
  `).run(newSize, newDate, newTime, newNotes, now, booking.id);

  // Re-notify staff so they see the updated time on their alerts list
  // (customer change is meaningful enough to ping the team again).
  const updated = db.prepare("SELECT * FROM bookings WHERE id = ?").get(booking.id) as Booking;
  const tableLabel = updated.table_id
    ? (db.prepare("SELECT label FROM tables WHERE id = ?").get(updated.table_id) as { label: string } | undefined)?.label ?? null
    : null;
  notifyStaff(branch, updated, tableLabel, "created").catch((e) => console.error("notify error", e));

  return NextResponse.json({ ok: true, action: "modified" });
}
