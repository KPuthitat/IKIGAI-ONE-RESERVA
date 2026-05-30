import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, type Booking, type Branch } from "@/lib/db";
import { notifyCustomerCancelled } from "@/lib/line";
import {
  onBookingStatusChanged as insignaOnBookingStatusChanged,
  hashLineUserId,
  hashPhone,
  generateAnonymousHash
} from "@/lib/insigna";

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

  // ── INSIGNA status sync ────────────────────────────────────
  // Translate the booking-side status into INSIGNA's narrower enum
  // (CONFIRMED / CANCELLED / NOSHOW / COMPLETED). Pass visit_args
  // when transitioning to 'seated' so the bridge can open an
  // INSIGNA visit row in the same call (the visit lifecycle starts
  // here, not at booking-create time on the customer LIFF path).
  //
  // The customer_hash is recomputed here from line_user_id / phone
  // because the bridge needs a hash to anchor the visit. Same hash
  // boundary as onBookingCreated — we never store the identifier.
  try {
    let visit_args: Parameters<typeof insignaOnBookingStatusChanged>[0]["visit_args"] = undefined;
    if (parsed.data.status === "seated") {
      // Derive customer_hash with the same precedence the bridge uses
      // (LINE > phone > anonymous) so the visit row points at the
      // SAME customer the reservation row points at.
      let customer_hash: string;
      if (booking.line_user_id) {
        customer_hash = hashLineUserId(booking.line_user_id);
      } else if (booking.customer_phone && booking.customer_phone.replace(/\D+/g, "").length >= 9) {
        customer_hash = hashPhone(booking.customer_phone);
      } else {
        customer_hash = generateAnonymousHash();
      }
      visit_args = {
        customer_hash,
        party_size: booking.party_size,
        party_type: booking.party_size === 1 ? "SOLO"
                  : booking.party_size === 2 ? "COUPLE"
                  : booking.party_size >= 5 ? "FAMILY"
                  : "FRIENDS",
        table_id: booking.table_id != null ? String(booking.table_id) : null
      };
    }
    insignaOnBookingStatusChanged({
      reservation_id: booking.ref_no || `id:${booking.id}`,
      new_status: parsed.data.status,
      visit_args
    });
  } catch (e) {
    console.warn("[insigna] status sync failed:", e);
  }

  return NextResponse.json({ ok: true });
}
