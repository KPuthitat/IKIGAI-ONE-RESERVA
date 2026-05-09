import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, type Booking, type Branch } from "@/lib/db";
import { isTableFree } from "@/lib/table-allocator";

// PATCH /api/admin/bookings/[id]/edit
//
// Admin-only edit endpoint. Unlike the customer-facing /api/reserva/edit/[ref]
// route, this one has no time cutoff — admin can adjust a booking right up
// to (and past) the booking time. Used by the timetable's BookingActionsModal
// for in-place edits without leaving the schedule view.
//
// Editable fields:
//   - party_size, booking_date, booking_time, notes (basic info)
//   - The current table is checked for availability under the new slot
//     when date or time changes. Conflict → 409 with table_unavailable.
//
// NOT here: status changes, table reassignment, cancel — those remain on
// the dedicated endpoints so the call sites stay easy to reason about.

const Body = z.object({
  party_size: z.number().int().min(1).max(50).optional(),
  booking_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  booking_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  notes: z.string().max(500).optional()
});

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const id = Number(params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const data = parsed.data;

  const db = getDb();
  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?")
    .get(id) as Booking | undefined;
  if (!booking) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!userHasBranch(user, booking.branch_id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const newDate = data.booking_date ?? booking.booking_date;
  const newTime = data.booking_time ?? booking.booking_time;
  const newSize = data.party_size ?? booking.party_size;
  // notes can be cleared to empty string — distinguish "not in body" from
  // "explicitly emptied". Body schema makes notes optional; if undefined,
  // keep existing.
  const newNotes = data.notes !== undefined ? data.notes : booking.notes;

  // Re-verify table availability if date or time changed and a table is
  // already assigned. Excluding self prevents the booking from blocking
  // itself.
  const dateChanged = newDate !== booking.booking_date;
  const timeChanged = newTime !== booking.booking_time;
  if (booking.table_id && (dateChanged || timeChanged)) {
    const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
      .get(booking.branch_id) as Branch | undefined;
    if (!branch) return NextResponse.json({ error: "branch_not_found" }, { status: 500 });
    const free = isTableFree({
      branchId: booking.branch_id,
      tableId: booking.table_id,
      date: newDate,
      time: newTime,
      durationMinutes: booking.duration_minutes,
      excludeBookingId: booking.id
    });
    if (!free) {
      return NextResponse.json({ error: "table_unavailable" }, { status: 409 });
    }
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE bookings
    SET party_size = ?, booking_date = ?, booking_time = ?,
        notes = ?, updated_at = ?
    WHERE id = ?
  `).run(newSize, newDate, newTime, newNotes, now, booking.id);

  return NextResponse.json({ ok: true });
}
