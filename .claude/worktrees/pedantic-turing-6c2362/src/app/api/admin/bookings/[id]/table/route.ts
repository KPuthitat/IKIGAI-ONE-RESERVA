import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, type Booking } from "@/lib/db";
import { isTableFree } from "@/lib/table-allocator";

const Body = z.object({ table_id: z.number().int().nullable() });

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

  if (parsed.data.table_id) {
    const free = isTableFree({
      branchId: booking.branch_id,
      tableId: parsed.data.table_id,
      date: booking.booking_date,
      time: booking.booking_time,
      durationMinutes: booking.duration_minutes,
      excludeBookingId: booking.id
    });
    if (!free) return NextResponse.json({ error: "โต๊ะนี้ถูกจองอยู่ในเวลาเดียวกัน" }, { status: 409 });
  }

  db.prepare("UPDATE bookings SET table_id = ?, updated_at = ? WHERE id = ?")
    .run(parsed.data.table_id, new Date().toISOString(), id);
  return NextResponse.json({ ok: true });
}
