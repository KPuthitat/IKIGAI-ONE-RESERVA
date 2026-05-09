// Server-only booking reference helpers.
//
// `isBookingRef` (the pure regex check) lives in lib/booking-ref.ts so
// it can be imported safely from client components. This file holds the
// generator that hits SQLite, hence the better-sqlite3 dependency that
// must stay out of the client bundle.

import { getDb } from "./db";

// Re-export the pure helper for callers who want a single import path.
export { isBookingRef } from "./booking-ref";

/** Format: 'R' + YYYYMM + 4-digit sequence per calendar month, e.g.
 *  R2026050001. Up to 9999 bookings per month — well above any single
 *  restaurant's volume. */
export function generateBookingRef(bookingDate: string): string {
  // bookingDate = 'YYYY-MM-DD' (Bangkok). Pull yearmonth from it.
  const yyyymm = bookingDate.slice(0, 4) + bookingDate.slice(5, 7);
  const pattern = `R${yyyymm}%`;
  const row = getDb().prepare(
    "SELECT COUNT(*) AS n FROM bookings WHERE ref_no LIKE ?"
  ).get(pattern) as { n: number };
  const seq = String(row.n + 1).padStart(4, "0");
  return `R${yyyymm}${seq}`;
}
