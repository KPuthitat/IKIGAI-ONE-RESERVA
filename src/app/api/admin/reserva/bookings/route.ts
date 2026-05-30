import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, OCCASION_KINDS, type Branch, type Booking } from "@/lib/db";
import { isTableFree } from "@/lib/table-allocator";
import { notifyStaff, notifyCustomer } from "@/lib/line";
import { generateBookingRef } from "@/lib/reserva-ref";
import { assignRedemptionForNewRow, normalisePhone } from "@/lib/redemption";
import { onBookingCreated as insignaOnBookingCreated } from "@/lib/insigna";

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
  // Special occasion — same enum as the customer endpoint. Lets staff
  // tag walk-in / phone-in bookings (e.g. "anniversary couple just
  // called") so the staff card surfaces the cue, and downstream
  // analytics counts these consistently with the customer-driven ones.
  occasion: z.enum(OCCASION_KINDS).optional(),
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

  // Normalise the phone before storage so the DB carries a single
  // canonical format (no dashes/spaces/parens). Same rationale as
  // the customer endpoint — comparison + display stay consistent.
  // Walk-ins may have an empty phone; keep it empty in that case.
  const normalisedPhone = data.customer_phone
    ? (normalisePhone(data.customer_phone) ?? data.customer_phone)
    : "";

  // First-time check (free-ice-cream promo). Walk-ins also qualify
  // since the customer chose us today regardless of channel. Phone
  // may be empty for walk-ins; assignRedemptionForNewRow returns
  // 'not_eligible' in that case (no way to verify "first-time").
  const { status: redemptionStatus, code: verificationCode } =
    assignRedemptionForNewRow({ phone: normalisedPhone });

  const ref = generateBookingRef(data.booking_date);
  const result = db.prepare(`
    INSERT INTO bookings (
      branch_id, table_id, customer_name, customer_phone, party_size,
      source, customer_origin, is_member,
      booking_date, booking_time, duration_minutes, notes, food_allergy,
      occasion,
      booking_channel, ref_no, status, created_by, seated_at, line_user_id,
      verification_code, redemption_status
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    branch.id,
    data.table_id ?? null,
    data.customer_name,
    normalisedPhone,
    data.party_size,
    data.source || null,
    data.customer_origin || null,
    data.is_member ?? null,
    data.booking_date,
    data.booking_time,
    branch.default_duration_minutes,
    data.notes || null,
    data.food_allergy || null,
    data.occasion ?? null,
    data.booking_channel,
    ref,
    initialStatus,
    user.id,
    seatedAt,
    data.line_user_id || null,
    verificationCode,
    redemptionStatus
  );
  const id = result.lastInsertRowid as number;

  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id) as Booking;
  const tableLabel = booking.table_id
    ? (db.prepare("SELECT label FROM tables WHERE id = ?").get(booking.table_id) as { label: string } | undefined)?.label ?? null
    : null;

  // ── INSIGNA push (privacy wall enforced inside the bridge) ────
  // The bridge hashes line_user_id or phone into a pseudonymous
  // customer_hash before writing. No raw PII reaches INSIGNA
  // tables. Fire-and-forget: a bridge failure (env not configured,
  // schema not migrated yet) MUST NOT block the booking write.
  insignaOnBookingCreated({
    // ref_no is the booking-side human-readable key; falls back to
    // numeric id when ref_no is unexpectedly empty (defensive).
    reservation_id: booking.ref_no || `id:${booking.id}`,
    line_user_id: booking.line_user_id,
    phone: booking.customer_phone || null,
    booked_at: new Date(booking.created_at).toISOString(),
    scheduled_at: new Date(`${booking.booking_date}T${booking.booking_time}:00+07:00`).toISOString(),
    party_size: booking.party_size,
    channel: data.booking_channel === "walkin" ? "WALKIN"
           : data.booking_channel === "phone"  ? "PHONE"
           : "LINE",
    special_occasion: booking.occasion ?? null,
    status: initialStatus,
    acquisition_source: booking.source ?? null,
    party_type: booking.party_size === 1 ? "SOLO"
              : booking.party_size === 2 ? "COUPLE"
              : booking.party_size >= 5 ? "FAMILY"
              : "FRIENDS",
    table_id: booking.table_id != null ? String(booking.table_id) : null
  });

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
