import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, type Booking, type Branch } from "@/lib/db";
import { notifyCustomerCancelled } from "@/lib/line";

// Admin status transitions for a booking. The cancel branch optionally
// accepts a `cancel_reason` (preset key or free text) which we store on
// the row + push to the customer in a "การจองถูกยกเลิก" Flex card.

const Body = z.object({
  status: z.enum(["confirmed", "seated", "no_show", "cancelled", "completed"]),
  cancel_reason: z.string().max(500).optional()
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
  if (parsed.data.status === "cancelled") {
    fields.cancelled_at = now;
    // Save the reason (or null when admin didn't pick one — e.g. silent
    // cancel from the staff-side timetable). Trim to keep DB tidy.
    fields.cancel_reason = parsed.data.cancel_reason?.trim() || null;
  }

  const sets = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE bookings SET ${sets} WHERE id = ?`).run(...Object.values(fields), id);

  // Notify customer if cancelled and we have a LINE userId on the booking.
  // Fire-and-forget — don't block the response on LINE API.
  if (parsed.data.status === "cancelled" && booking.line_user_id) {
    const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
      .get(booking.branch_id) as Branch | undefined;
    if (branch) {
      const updated = db.prepare("SELECT * FROM bookings WHERE id = ?")
        .get(booking.id) as Booking;
      notifyCustomerCancelled(branch, updated).catch((e) =>
        console.error("notify cancel error", e)
      );
    }
  }

  return NextResponse.json({ ok: true });
}
