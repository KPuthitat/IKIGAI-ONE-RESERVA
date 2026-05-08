import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, type Branch, type Booking } from "@/lib/db";
import { isTableFree } from "@/lib/table-allocator";
import { notifyStaff, notifyCustomer } from "@/lib/line";

// POST /api/admin/reserva/bookings
//
// Staff-side booking creation: walk-in (customer is here right now) or
// phone (staff entered a future booking from a phone call). Same fields
// as the customer endpoint /api/bookings, plus an explicit booking_channel
// of 'walkin' | 'phone' to track origin in monthly stats.
//
// 'walkin' bookings default to status='seated' (customer is already at
// the table). 'phone' bookings default to status='confirmed' (future
// reservation, just like online).

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
  table_id: z.number().int().nullable().optional(),
  booking_channel: z.enum(["walkin", "phone"])
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
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
  // Phone bookings still need to be present-or-future.
  if (data.booking_channel === "phone") {
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

  const initialStatus = data.booking_channel === "walkin" ? "seated" : "confirmed";
  const seatedAt = data.booking_channel === "walkin" ? new Date().toISOString() : null;

  const result = db.prepare(`
    INSERT INTO bookings (
      branch_id, table_id, customer_name, customer_phone, party_size,
      source, customer_origin, is_member,
      booking_date, booking_time, duration_minutes, notes,
      booking_channel, status, created_by, seated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
    data.booking_channel,
    initialStatus,
    user.id,
    seatedAt
  );
  const id = result.lastInsertRowid as number;

  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id) as Booking;
  const tableLabel = booking.table_id
    ? (db.prepare("SELECT label FROM tables WHERE id = ?").get(booking.table_id) as { label: string } | undefined)?.label ?? null
    : null;

  // Only push the staff alert (other staff on duty want to know). The
  // customer wasn't online when this was entered, so we don't have a
  // line_user_id to push the customer card to — notifyCustomer would
  // short-circuit anyway. Skip it explicitly to avoid log noise.
  Promise.all([
    notifyStaff(branch, booking, tableLabel, "created"),
    // Send to customer too IF a line_user_id was somehow provided (rare —
    // e.g., admin pasted a known regular's userId). Cheap to attempt.
    booking.line_user_id ? notifyCustomer(branch, booking, "created") : Promise.resolve()
  ]).catch((e) => console.error("notify error", e));

  return NextResponse.json({ id, status: initialStatus });
}
