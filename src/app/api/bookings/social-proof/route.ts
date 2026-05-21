import { NextResponse } from "next/server";
import { getDb, type Branch } from "@/lib/db";

// GET /api/bookings/social-proof?branch_slug=X&date=YYYY-MM-DD
//
// Real-numbers social-proof / scarcity endpoint for the public booking
// page. Everything here is computed from actual bookings — we never
// inflate counts, since at our volume (~120 bookings/branch/month)
// customers would catch fake numbers across visits and trust would
// vanish.
//
// Returns:
//   weekly      — rolling 7-day count of confirmed/seated bookings + guests.
//                 Why weekly: at 4 bookings/day a daily count of 0/1
//                 sometimes goes backwards; the weekly window smooths
//                 it out so the message stays warm.
//   today       — bookings + guests for the requested date specifically.
//                 Used for "วันนี้มีคนจอง X คน" only when > some
//                 threshold; the client decides whether to display.
//   slots       — per-time-slot booked seats, with a "popular" flag set
//                 when the slot was the most-booked one over the last
//                 30 days (top 30% by booking count). Lets the client
//                 render "🔥 รอบนิยม" badges grounded in real history.
//   totalCapacity — sum of active tables' capacity (so the client can
//                 compute "remaining" for any slot if it wants to render
//                 scarcity hints like "เหลือ 4 ที่").
//
// Cached for 60s at the edge (s-maxage). At low volume that's fine —
// a customer refreshing the page won't see counts move within a minute.

const STATUS_COUNTED = ["confirmed", "seated", "completed"] as const;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const slug = url.searchParams.get("branch_slug") ?? "";
  const date = url.searchParams.get("date") ?? "";
  if (!slug || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "invalid_params" }, { status: 400 });
  }
  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE slug = ?").get(slug) as Branch | undefined;
  if (!branch) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // ── Weekly window (today and 6 days back, BKK calendar) ───────────
  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() + 7 * 60 * 60 * 1000 - 6 * 86400000)
    .toISOString().slice(0, 10);
  const placeholders = STATUS_COUNTED.map(() => "?").join(",");
  const weekly = db.prepare(`
    SELECT COUNT(*) AS bookings, COALESCE(SUM(party_size), 0) AS guests
    FROM bookings
    WHERE branch_id = ?
      AND booking_date BETWEEN ? AND ?
      AND status IN (${placeholders})
  `).get(branch.id, sevenDaysAgo, todayBkk, ...STATUS_COUNTED) as {
    bookings: number; guests: number;
  };

  // ── Today's count (for the requested date, not necessarily today) ─
  const today = db.prepare(`
    SELECT COUNT(*) AS bookings, COALESCE(SUM(party_size), 0) AS guests
    FROM bookings
    WHERE branch_id = ?
      AND booking_date = ?
      AND status IN (${placeholders})
  `).get(branch.id, date, ...STATUS_COUNTED) as {
    bookings: number; guests: number;
  };

  // ── Per-slot booked seats for the requested date ──────────────────
  // We aggregate by HH:MM so the client can match the dropdown options
  // directly. Filtering by status here matters: we don't want a
  // cancelled booking to count against availability.
  const slotRows = db.prepare(`
    SELECT booking_time AS time, SUM(party_size) AS booked_seats
    FROM bookings
    WHERE branch_id = ?
      AND booking_date = ?
      AND status IN (${placeholders})
    GROUP BY booking_time
  `).all(branch.id, date, ...STATUS_COUNTED) as Array<{
    time: string; booked_seats: number;
  }>;

  // ── "Popular slot" inference from last 30 days ────────────────────
  // Counts how often each slot appears across recent confirmed/seated
  // bookings. Top 30% (rounded up, min 1) by count get the popular
  // flag. This gives stable signals — a slot that was busy last
  // Saturday stays marked even if today's booking-window is quiet.
  const thirtyDaysAgo = new Date(Date.now() + 7 * 60 * 60 * 1000 - 29 * 86400000)
    .toISOString().slice(0, 10);
  const slotHistory = db.prepare(`
    SELECT booking_time AS time, COUNT(*) AS n
    FROM bookings
    WHERE branch_id = ?
      AND booking_date BETWEEN ? AND ?
      AND status IN (${placeholders})
    GROUP BY booking_time
    ORDER BY n DESC
  `).all(branch.id, thirtyDaysAgo, todayBkk, ...STATUS_COUNTED) as Array<{
    time: string; n: number;
  }>;
  const popularCutoff = Math.max(1, Math.ceil(slotHistory.length * 0.3));
  const popularSlots = new Set(slotHistory.slice(0, popularCutoff).map((r) => r.time));

  const slots = slotRows.map((r) => ({
    time: r.time,
    bookedSeats: Number(r.booked_seats ?? 0),
    popular: popularSlots.has(r.time)
  }));

  // ── Total capacity (active tables) ───────────────────────────────
  const cap = db.prepare(`
    SELECT COALESCE(SUM(capacity), 0) AS total
    FROM tables
    WHERE branch_id = ? AND active = 1
  `).get(branch.id) as { total: number };

  const res = NextResponse.json({
    weekly: { bookings: weekly.bookings, guests: weekly.guests },
    today: { bookings: today.bookings, guests: today.guests },
    slots,
    totalCapacity: cap.total
  });
  // 60-second cache so a curious customer doesn't see new numbers
  // every keystroke when scrolling the form. Long enough to take
  // load off SQLite, short enough that staff-side activity shows up
  // within a minute.
  res.headers.set("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
  return res;
}
