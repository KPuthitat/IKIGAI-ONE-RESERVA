import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, type Branch, type Booking } from "@/lib/db";
import { notifyStaff } from "@/lib/line";
import { generateBookingRef } from "@/lib/reserva-ref";

// Online customer booking request — saved as 'pending' without a table.
// Admin reviews on /admin/reserva/bookings, assigns a table, and clicks
// "Confirm" which transitions to 'confirmed' AND pushes the customer
// Flex card with QR. The customer-facing endpoint never picks the table.
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

  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (data.booking_date < todayBkk) {
    return NextResponse.json({ error: "ไม่สามารถจองย้อนหลังได้" }, { status: 400 });
  }

  const ref = generateBookingRef(data.booking_date);
  const result = db.prepare(`
    INSERT INTO bookings (
      branch_id, table_id, customer_name, customer_phone, party_size,
      source, customer_origin, is_member,
      booking_date, booking_time, duration_minutes, notes, line_user_id, lang,
      booking_channel, ref_no, status
    ) VALUES (?, NULL, ?,?,?,?,?,?,?,?,?,?,?,?, 'online', ?, 'pending')
  `).run(
    branch.id,
    data.customer_name,
    data.customer_phone,
    data.party_size,
    data.source || null,
    data.customer_origin || null,
    data.is_member ?? null,
    data.booking_date,
    data.booking_time,
    branch.default_duration_minutes,
    data.notes || null,
    data.line_user_id || null,
    data.lang ?? null,
    ref
  );
  const id = result.lastInsertRowid as number;

  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id) as Booking;

  // Staff alert only — customer Flex+QR is held until admin confirms a
  // table. The card without a table_id would be misleading, and the QR
  // wouldn't resolve to a valid /r/<ref> entry yet.
  notifyStaff(branch, booking, null, "created").catch((e) => console.error("notify error", e));

  return NextResponse.json({ id, status: "pending" });
}
