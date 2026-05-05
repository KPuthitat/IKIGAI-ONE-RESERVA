import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, type Booking } from "@/lib/db";

const Body = z.object({
  status: z.enum(["confirmed", "seated", "no_show", "cancelled", "completed"])
});

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "ยังไม่ได้เข้าระบบ" }, { status: 401 });
  const id = Number(params.id);
  const json = await req.json();
  const parsed = Body.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });

  const db = getDb();
  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id) as Booking | undefined;
  if (!booking) return NextResponse.json({ error: "ไม่พบการจอง" }, { status: 404 });
  if (!userHasBranch(user, booking.branch_id)) {
    return NextResponse.json({ error: "ไม่มีสิทธิ์" }, { status: 403 });
  }

  const now = new Date().toISOString();
  const fields: Record<string, string | null> = {
    status: parsed.data.status,
    updated_at: now
  };
  if (parsed.data.status === "seated") fields.seated_at = now;
  if (parsed.data.status === "cancelled") fields.cancelled_at = now;

  const sets = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE bookings SET ${sets} WHERE id = ?`).run(...Object.values(fields), id);
  return NextResponse.json({ ok: true });
}
