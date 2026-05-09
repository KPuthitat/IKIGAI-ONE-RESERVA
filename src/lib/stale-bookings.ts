import { getDb, type Booking } from "./db";
import { bookingStartMs } from "./time";

// Auto-mark confirmed bookings as no_show when they run past their start
// time + 30 min without staff acting on them. Admin can still hit
// "นั่งแล้ว" later if the customer arrives late — no_show is reversible.
//
// pending_review bookings are NOT auto-cancelled here: admin reviews them
// manually, and shouldn't lose a customer's request because they were
// busy during service. The pending queue stays in /admin/reserva/pending
// until admin confirms or cancels by hand.
//
// The function is idempotent and cheap — single SQL filter on indexed
// status column, then UPDATE per row that matches the time threshold.
// Safe to call from any page load and from the external cron without
// coordination.
export function autoExpireStaleBookings(): { no_show_count: number } {
  const db = getDb();
  const cutoffMs = Date.now() - 30 * 60_000;

  const stale = db.prepare(`
    SELECT * FROM bookings WHERE status = 'confirmed'
  `).all() as Booking[];

  let noShow = 0;
  const update = db.prepare(
    "UPDATE bookings SET status = 'no_show', updated_at = ? WHERE id = ? AND status = 'confirmed'"
  );

  for (const b of stale) {
    if (bookingStartMs(b.booking_date, b.booking_time) >= cutoffMs) continue;
    // The `AND status = 'confirmed'` guard makes this safe under concurrent
    // updates — if another request already changed the status (e.g. admin
    // marked seated), our UPDATE is a no-op (changes = 0) and we don't
    // double-count.
    const res = update.run(new Date().toISOString(), b.id);
    if (res.changes === 0) continue;
    noShow++;
  }

  return { no_show_count: noShow };
}
