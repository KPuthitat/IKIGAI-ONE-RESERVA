import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, type Booking, type Branch } from "@/lib/db";
import { notifyCustomer } from "@/lib/line";

const Body = z.object({
  status: z.enum(["pending", "confirmed", "seated", "no_show", "cancelled", "completed"])
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

  const next = parsed.data.status;
  const isConfirmingPending = booking.status === "pending" && next === "confirmed";

  // Pending → confirmed requires a table to be assigned. Without one the
  // customer Flex card would advertise "table not assigned", and the QR
  // would resolve to a booking that staff can't seat. Guard here so the
  // server stays consistent even if the UI ever forgets.
  if (isConfirmingPending && booking.table_id == null) {
    return NextResponse.json({ error: "no_table_assigned" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const fields: Record<string, string | null> = {
    status: next,
    updated_at: now
  };
  if (next === "seated") fields.seated_at = now;
  if (next === "cancelled") fields.cancelled_at = now;

  const sets = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE bookings SET ${sets} WHERE id = ?`).run(...Object.values(fields), id);

  // Send the customer Flex card the first time we confirm a pending
  // booking. Note: notifyCustomer already logs sent/failed/skipped to
  // notification_log, and there's only one place that creates a 'created'
  // log row for customers — this confirm step — so we don't need a
  // separate dedupe check.
  if (isConfirmingPending && booking.line_user_id) {
    const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
      .get(booking.branch_id) as Branch | undefined;
    if (branch) {
      const fresh = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id) as Booking;
      notifyCustomer(branch, fresh, "created").catch((e) =>
        console.error("notify on confirm error", e)
      );
    }
  }

  return NextResponse.json({ ok: true });
}
