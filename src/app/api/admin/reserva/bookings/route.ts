import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, type Branch, type Booking } from "@/lib/db";
import { isTableFree } from "@/lib/table-allocator";
import { notifyStaff, notifyCustomer } from "@/lib/line";
import { generateBookingRef } from "@/lib/reserva-ref";

// POST /api/admin/reserva/bookings
//
// Staff-side booking creation. Three channels:
//   walkin — customer is already at the restaurant. Default status='seated'
//            (table is theirs right now). Past-date is allowed.
//   phone  — customer called. Default status='confirmed' if a table is
//            picked, 'pending_review' if not. Future-only.
//   line   — customer messaged via the LINE OA chat directly (didn't go
//            through the public form). Same status rules as 'phone'. If
//            staff pasted the customer's LINE userId, the confirmation
//            Flex card is pushed back to that user when the booking is
//            confirmed (either immediately or later via the confirm
//            endpoint).
//
// Same fields as the customer endpoint /api/bookings, plus an explicit
// booking_channel value.

const Body = z.object({
  customer_name: z.string().trim().min(1).max(100),
  customer_phone: z.string().trim().min(0).max(30),     // walk-in may be empty
  party_size: z.number().int().min(1).max(50),
  booking_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  booking_time: z.string().regex(/^\d{2}:\d{2}$/),
  source: z.string().max(200).optional().default(""),   // marketing source (JSON or string)
  customer_origin: z.string().max(50).optional().default(""),
  is_member: z.union([z.literal(0), z.literal(1)]).nullable().optional(),
  notes: z.string().max(500).optional().default(""),
  // Food allergies / dietary restrictions — surfaced to staff in the
  // table-survey flow. Optional free text; kept separate from `notes`
  // so it's easy to query "any allergy info?" without parsing.
  food_allergy: z.string().max(500).optional().default(""),
  table_id: z.number().int().nullable().optional(),
  line_user_id: z.string().max(64).optional().default(""),
  booking_channel: z.enum(["walkin", "phone", "line"])
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;

  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) return NextResponse.json({ error: "branch_not_found" }, { status: 404 });

  // Walk-ins skip the past-date guard since they're happening right now.
  // Phone / line bookings still need to be present-or-future.
  if (data.booking_channel !== "walkin") {
    const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (data.booking_date < todayBkk) {
      return NextResponse.json({ error: "no_past_booking" }, { status: 400 });
    }
  }

  // Same race-condition check as the customer endpoint
  if (data.table_id) {
    const free = isTableFree({
      branchId: branch.id,
      tableId: data.table_id,
      date: data.booking_date,
      time: data.booking_time,
      durationMinutes: branch.default_duration_minutes
    });
    if (!free) {
      return NextResponse.json({ error: "table_unavailable" }, { status: 409 });
    }
  }

  // Initial status decision tree:
  //   walk-in: always 'seated' (customer is at the table now)
  //   phone / line with table: 'confirmed' (full confirmation, push Flex)
  //   phone / line without table: 'pending_review' (admin will assign + confirm later)
  let initialStatus: "seated" | "confirmed" | "pending_review";
  if (data.booking_channel === "walkin") {
    initialStatus = "seated";
  } else if (data.table_id) {
    initialStatus = "confirmed";
  } else {
    initialStatus = "pending_review";
  }
  const seatedAt = data.booking_channel === "walkin" ? new Date().toISOString() : null;

  const ref = generateBookingRef(data.booking_date);
  const result = db.prepare(`
    INSERT INTO bookings (
      branch_id, table_id, customer_name, customer_phone, party_size,
      source, customer_origin, is_member,
      booking_date, booking_time, duration_minutes, notes, food_allergy,
      booking_channel, ref_no, status, created_by, seated_at, line_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    branch.id,
    data.table_id ?? null,
    data.customer_name,
    data.customer_phone || "",
    data.party_size,
    data.source || null,
    data.customer_origin || null,
    data.is_member ?? null,
    data.booking_date,
    data.booking_time,
    branch.default_duration_minutes,
    data.notes || null,
    data.food_allergy || null,
    data.booking_channel,
    ref,
    initialStatus,
    user.id,
    seatedAt,
    data.line_user_id || null
  );
  const id = result.lastInsertRowid as number;

  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id) as Booking;
  const tableLabel = booking.table_id
    ? (db.prepare("SELECT label FROM tables WHERE id = ?").get(booking.table_id) as { label: string } | undefined)?.label ?? null
    : null;

  // Notification policy:
  //   - Always notify staff (so others on duty see the new booking)
  //   - Notify customer with the Flex card ONLY if status is confirmed/seated
  //     AND a line_user_id is on file. Pending review skips the customer
  //     card — they'll get it when admin clicks Confirm.
  const staffKind = initialStatus === "pending_review" ? "pending_review" : "created";
  Promise.all([
    notifyStaff(branch, booking, tableLabel, staffKind),
    initialStatus !== "pending_review" && booking.line_user_id
      ? notifyCustomer(branch, booking, "created")
      : Promise.resolve()
  ]).catch((e) => console.error("notify error", e));

  return NextResponse.json({
    id,
    ref: booking.ref_no,
    status: initialStatus,
    booking_channel: data.booking_channel,
    has_line_user_id: !!booking.line_user_id
  });
}
