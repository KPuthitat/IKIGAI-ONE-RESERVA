import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, type Booking } from "@/lib/db";
import { isTableFree } from "@/lib/table-allocator";
import { setBookingTables } from "@/lib/booking-tables";

// Assign a booking to one table OR a merged set of tables (owner 2026-07-26).
// `table_ids` (the full set) is preferred; `table_id` is kept for back-compat.
const Body = z.object({
  table_id: z.number().int().nullable().optional(),
  table_ids: z.array(z.number().int().positive()).max(20).optional()
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "ยังไม่ได้เข้าระบบ" }, { status: 401 });
  const id = Number(params.id);
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });

  const db = getDb();
  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id) as Booking | undefined;
  if (!booking) return NextResponse.json({ error: "ไม่พบการจอง" }, { status: 404 });
  if (!userHasBranch(user, booking.branch_id)) {
    return NextResponse.json({ error: "ไม่มีสิทธิ์" }, { status: 403 });
  }

  // Resolve the requested set (dedup). table_ids wins; else the single table_id.
  const tableIds = parsed.data.table_ids
    ? [...new Set(parsed.data.table_ids)]
    : parsed.data.table_id
      ? [parsed.data.table_id]
      : [];

  // Every table in the set must be free at this slot (anchor + merged).
  for (const tid of tableIds) {
    const free = isTableFree({
      branchId: booking.branch_id, tableId: tid,
      date: booking.booking_date, time: booking.booking_time,
      durationMinutes: booking.duration_minutes, excludeBookingId: booking.id
    });
    if (!free) return NextResponse.json({ error: "มีโต๊ะในชุดนี้ถูกจองอยู่ในเวลาเดียวกัน" }, { status: 409 });
  }

  setBookingTables(id, tableIds);               // anchor + booking_tables in sync
  db.prepare("UPDATE bookings SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  return NextResponse.json({ ok: true });
}
