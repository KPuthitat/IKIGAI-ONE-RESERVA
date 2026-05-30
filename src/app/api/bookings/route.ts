import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, OCCASION_KINDS, type Branch, type Booking } from "@/lib/db";
import { notifyCustomerPending, notifyStaff } from "@/lib/line";
import { generateBookingRef } from "@/lib/reserva-ref";
import { assignRedemptionForNewRow, normalisePhone } from "@/lib/redemption";
import { onBookingCreated as insignaOnBookingCreated } from "@/lib/insigna";

// Customer-facing booking endpoint.
//
// Two-step workflow (changed 2026-05-09): the customer submits without a
// table — status becomes 'pending_review'. Admin reviews in the back office,
// assigns a table, then clicks "Confirm and notify" which pushes the Flex
// confirmation card with QR. This endpoint therefore:
//   1. accepts no table_id (server forces null)
//   2. creates the row with status='pending_review'
//   3. sends a plain-text "ได้รับคำขอจอง — รอการยืนยัน" message back to
//      the customer (no Flex card yet)
//   4. notifies staff that a new pending review needs attention

const Body = z.object({
  branch_slug: z.string(),
  customer_name: z.string().trim().min(1).max(100),
  customer_phone: z.string().trim().min(6).max(30),
  party_size: z.number().int().min(1).max(50),
  booking_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  booking_time: z.string().regex(/^\d{2}:\d{2}$/),
  source: z.string().max(200).optional().default(""),
  customer_origin: z.string().max(50).optional().default(""),
  is_member: z.union([z.literal(0), z.literal(1)]).nullable().optional(),
  notes: z.string().max(500).optional().default(""),
  // Food allergies / dietary restrictions — free text optional. Stored
  // separately from `notes` so staff can surface it on the table
  // survey without parsing the general notes field.
  food_allergy: z.string().max(500).optional().default(""),
  // Special occasion — one of OCCASION_KINDS or omitted/empty for
  // "not specified". Drives the personalised LINE reply customer
  // gets immediately after submitting (notifyCustomerPending) and
  // shows on the staff Flex card so the team can prepare.
  occasion: z.enum(OCCASION_KINDS).optional(),
  line_user_id: z.string().max(64).optional().default(""),
  lang: z.enum(["th", "en"]).optional()
});

export async function POST(req: Request) {
  const json = await req.json();
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "ข้อมูลไม่ถูกต้อง", issues: parsed.error.issues }, { status: 400 });
  }
  const data = parsed.data;
  const db = getDb();

  const branch = db.prepare("SELECT * FROM branches WHERE slug = ?").get(data.branch_slug) as Branch | undefined;
  if (!branch) return NextResponse.json({ error: "ไม่พบสาขา" }, { status: 404 });

  // Branch must be actively open for bookings. Blocks direct POSTs / stale
  // links to a 'coming_soon' or 'closed' branch even though the public list
  // already hides/greys them out.
  if (branch.status !== "open") {
    return NextResponse.json(
      { error: "สาขานี้ปิดรับจองอยู่ในขณะนี้" },
      { status: 403 }
    );
  }

  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (data.booking_date < todayBkk) {
    return NextResponse.json({ error: "ไม่สามารถจองย้อนหลังได้" }, { status: 400 });
  }

  // No table_id race-condition check needed — admin picks the table later
  // when confirming. The only remaining guard is the past-date one above.

  // Normalise the phone before storage so the DB carries a single
  // canonical format (digits + leading "+" only — no dashes / spaces
  // / parens). Comparison-heavy paths like hasPriorVisit can then
  // match without REPLACE() acrobatics, and the admin UI shows a
  // consistent string instead of whatever the customer typed.
  const normalisedPhone = normalisePhone(data.customer_phone) ?? data.customer_phone;

  // First-time check (free-ice-cream promo). Decides at insert time;
  // re-running would race if two customers share a phone and submit
  // back-to-back, but the chance is negligible at our volume.
  const { status: redemptionStatus, code: verificationCode } =
    assignRedemptionForNewRow({ phone: normalisedPhone });

  const ref = generateBookingRef(data.booking_date);
  const result = db.prepare(`
    INSERT INTO bookings (
      branch_id, table_id, customer_name, customer_phone, party_size,
      source, customer_origin, is_member,
      booking_date, booking_time, duration_minutes, notes, food_allergy,
      occasion,
      line_user_id, lang,
      booking_channel, ref_no, status,
      verification_code, redemption_status
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'online', ?, 'pending_review', ?, ?)
  `).run(
    branch.id,
    null,                                    // table_id always null at this stage
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
    data.line_user_id || null,
    data.lang ?? null,
    ref,
    verificationCode,
    redemptionStatus
  );
  const id = result.lastInsertRowid as number;

  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id) as Booking;

  // INSIGNA push (privacy wall enforced inside the bridge). Customer
  // bookings flow through line_user_id or normalised phone; the
  // bridge hashes either into a pseudonymous customer_hash before
  // any data lands in insigna_* tables. status='pending_review' on
  // this path means no visit is opened yet — that happens when
  // admin flips status to seated.
  insignaOnBookingCreated({
    reservation_id: booking.ref_no || `id:${booking.id}`,
    line_user_id: booking.line_user_id,
    phone: booking.customer_phone || null,
    booked_at: new Date(booking.created_at).toISOString(),
    scheduled_at: new Date(`${booking.booking_date}T${booking.booking_time}:00+07:00`).toISOString(),
    party_size: booking.party_size,
    channel: "LINE",  // /api/bookings is the LIFF customer route
    special_occasion: booking.occasion ?? null,
    status: "pending_review",
    acquisition_source: booking.source ?? null,
    party_type: booking.party_size === 1 ? "SOLO"
              : booking.party_size === 2 ? "COUPLE"
              : booking.party_size >= 5 ? "FAMILY"
              : "FRIENDS"
  });

  // Notify (fire-and-forget; ไม่ block response). Customer gets a plain
  // text acknowledgement only — the Flex card is sent later when admin
  // confirms. Staff get a card so they know to review.
  Promise.all([
    notifyCustomerPending(branch, booking),
    notifyStaff(branch, booking, null, "pending_review")
  ]).catch((e) => console.error("notify error", e));

  return NextResponse.json({ id, ref, status: "pending_review" });
}
