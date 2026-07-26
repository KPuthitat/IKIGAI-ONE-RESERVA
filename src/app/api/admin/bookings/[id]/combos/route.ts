import { NextResponse } from "next/server";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, type Booking } from "@/lib/db";
import { suggestCombos } from "@/lib/table-allocator";

// Suggested table sets for a booking's party + slot (owner 2026-07-26) — single
// tables and adjacent-table merges, ranked. Used by the timetable action modal.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "ยังไม่ได้เข้าระบบ" }, { status: 401 });
  const db = getDb();
  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(Number(params.id)) as Booking | undefined;
  if (!booking) return NextResponse.json({ error: "ไม่พบการจอง" }, { status: 404 });
  if (!userHasBranch(user, booking.branch_id)) return NextResponse.json({ error: "ไม่มีสิทธิ์" }, { status: 403 });

  const combos = suggestCombos({
    branchId: booking.branch_id, date: booking.booking_date, time: booking.booking_time,
    durationMinutes: booking.duration_minutes, partySize: booking.party_size,
    excludeBookingId: booking.id, limit: 6
  });
  return NextResponse.json({
    combos: combos.map((c) => ({
      table_ids: c.tables.map((t) => t.id),
      labels: c.tables.map((t) => t.label),
      totalCapacity: c.totalCapacity,
      waste: c.waste,
      crossZone: c.crossZone
    }))
  });
}
