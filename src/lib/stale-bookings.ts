import { getDb, type Booking } from "./db";
import { bookingStartMs } from "./time";

// Auto-expire bookings that ran past their start time without action:
//   confirmed     → no_show   (customer didn't arrive; admin can still
//                              hit "นั่งแล้ว" if they show up late)
//   pending_review → cancelled (admin never confirmed; the booking
//                               never went live, treat as cancelled)
//
// Cutoff is `start_time + 30 min`. The function is idempotent and cheap
// — single SQL filter on indexed status column, then UPDATE per row that
// matches the time threshold. Safe to call from any page load and from
// the external cron without coordination.
export function autoExpireStaleBookings(): {
  no_show_count: number;
  cancelled_pending_count: number;
} {
  const db = getDb();
  const cutoffMs = Date.now() - 30 * 60_000;

  const stale = db.prepare(`
    SELECT * FROM bookings WHERE status IN ('confirmed','pending_review')
  `).all() as Booking[];

  let noShow = 0;
  let cancelledPending = 0;
  const update = db.prepare(
    "UPDATE bookings SET status = ?, updated_at = ?, cancelled_at = COALESCE(?, cancelled_at) WHERE id = ? AND status = ?"
  );

  for (const b of stale) {
    if (bookingStartMs(b.booking_date, b.booking_time) >= cutoffMs) continue;
    const newStatus = b.status === "pending_review" ? "cancelled" : "no_show";
    const now = new Date().toISOString();
    const cancelledAt = newStatus === "cancelled" ? now : null;
    // The `AND status = ?` guard makes this safe under concurrent updates
    // — if another request already changed the status, our UPDATE is a
    // no-op (changes = 0) and we don't double-count.
    const res = update.run(newStatus, now, cancelledAt, b.id, b.status);
    if (res.changes === 0) continue;
    if (newStatus === "no_show") noShow++;
    else cancelledPending++;
  }

  return { no_show_count: noShow, cancelled_pending_count: cancelledPending };
}
