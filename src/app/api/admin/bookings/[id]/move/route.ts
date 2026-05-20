import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, type Booking } from "@/lib/db";
import { isTableFree } from "@/lib/table-allocator";

// POST /api/admin/bookings/[id]/move
// Used by the timetable's drag-and-drop: admin drags a booking card to
// a different table row + time slot. Atomically updates table_id +
// booking_time after checking the target slot is free (excluding the
// booking itself, so a no-op drop is a no-op, not a conflict).
//
//   body: { table_id: number, booking_time: "HH:MM" }

const Body = z.object({
  table_id: z.number().int().positive(),
  booking_time: z.string().regex(/^\d{2}:\d{2}$/)
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const db = getDb();
  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?")
    .get(id) as Booking | undefined;
  if (!booking) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!userHasBranch(user, booking.branch_id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Target table must belong to the same branch — prevents drag-and-drop
  // accidentally moving a booking across branches.
  const tbl = db.prepare("SELECT id, branch_id, active FROM tables WHERE id = ?")
    .get(parsed.data.table_id) as { id: number; branch_id: number; active: number } | undefined;
  if (!tbl || tbl.branch_id !== booking.branch_id || tbl.active !== 1) {
    return NextResponse.json({ error: "table_unavailable" }, { status: 409 });
  }

  // Slot-conflict check (excluding self → a drop onto the same cell is a
  // no-op, not a conflict).
  const free = isTableFree({
    branchId: booking.branch_id,
    tableId: parsed.data.table_id,
    date: booking.booking_date,
    time: parsed.data.booking_time,
    durationMinutes: booking.duration_minutes,
    excludeBookingId: booking.id
  });
  if (!free) {
    return NextResponse.json({ error: "slot_conflict" }, { status: 409 });
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE bookings
    SET table_id = ?, booking_time = ?, updated_at = ?
    WHERE id = ?
  `).run(parsed.data.table_id, parsed.data.booking_time, now, id);

  return NextResponse.json({ ok: true });
}
