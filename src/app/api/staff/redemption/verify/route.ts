import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { normaliseCode } from "@/lib/verification-code";

// POST /api/staff/redemption/verify
//
// Staff types a code (or pastes one read from the customer's screen)
// and asks "does this match?". Returns the matching booking OR
// walk-in row plus a status pill so the staff UI can render a
// preview before the staff clicks the actual "เคลมไอติม" button.
//
// Returns 404 if no row matches — staff sees "ไม่พบรหัสนี้". Returns
// 403 if the code matches but belongs to a different branch (so
// staff at NAMA can't accidentally claim a HYPO code).

const Body = z.object({
  code: z.string().min(1).max(20)
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const code = normaliseCode(parsed.data.code);
  if (!code) {
    return NextResponse.json({ error: "invalid_code_format" }, { status: 400 });
  }

  const db = getDb();
  // Try booking first; if not found, try walk-in. Codes are unique
  // across both tables (issueUniqueCode probes both).
  const booking = db.prepare(`
    SELECT b.id, b.branch_id, b.customer_name, b.customer_phone,
           b.party_size, b.booking_date, b.booking_time, b.ref_no,
           b.redemption_status, b.redeemed_at, b.status,
           br.name AS branch_name
    FROM bookings b
    JOIN branches br ON br.id = b.branch_id
    WHERE b.verification_code = ?
    LIMIT 1
  `).get(code) as {
    id: number; branch_id: number; customer_name: string;
    customer_phone: string; party_size: number; booking_date: string;
    booking_time: string; ref_no: string | null;
    redemption_status: string | null; redeemed_at: string | null;
    status: string; branch_name: string;
  } | undefined;

  if (booking) {
    if (user.role !== "super_admin" && booking.branch_id !== user.activeBranchId) {
      return NextResponse.json({ error: "wrong_branch", branch_name: booking.branch_name }, { status: 403 });
    }
    return NextResponse.json({
      kind: "booking",
      id: booking.id,
      branch_id: booking.branch_id,
      branch_name: booking.branch_name,
      customer_name: booking.customer_name,
      customer_phone: booking.customer_phone,
      party_size: booking.party_size,
      booking_date: booking.booking_date,
      booking_time: booking.booking_time,
      ref_no: booking.ref_no,
      booking_status: booking.status,
      redemption_status: booking.redemption_status,
      redeemed_at: booking.redeemed_at
    });
  }

  const walkIn = db.prepare(`
    SELECT w.id, w.branch_id, w.guest_name, w.phone, w.party_size,
           w.visited_at, w.redemption_status, w.redeemed_at,
           br.name AS branch_name
    FROM walk_in_visits w
    JOIN branches br ON br.id = w.branch_id
    WHERE w.verification_code = ?
    LIMIT 1
  `).get(code) as {
    id: number; branch_id: number; guest_name: string | null;
    phone: string | null; party_size: number; visited_at: string;
    redemption_status: string | null; redeemed_at: string | null;
    branch_name: string;
  } | undefined;

  if (walkIn) {
    if (user.role !== "super_admin" && walkIn.branch_id !== user.activeBranchId) {
      return NextResponse.json({ error: "wrong_branch", branch_name: walkIn.branch_name }, { status: 403 });
    }
    return NextResponse.json({
      kind: "walk_in",
      id: walkIn.id,
      branch_id: walkIn.branch_id,
      branch_name: walkIn.branch_name,
      customer_name: walkIn.guest_name,
      customer_phone: walkIn.phone,
      party_size: walkIn.party_size,
      visited_at: walkIn.visited_at,
      redemption_status: walkIn.redemption_status,
      redeemed_at: walkIn.redeemed_at
    });
  }

  return NextResponse.json({ error: "not_found" }, { status: 404 });
}
