// Booking reference generator.
//
// Format: 'R' + YYYY + MM + 4-digit sequence (zero-padded), per calendar
// month of the booking_date. So the first booking in May 2026 is
// 'R2026050001', the second is 'R2026050002', etc. Up to 9999 bookings
// per month — comfortably above any single restaurant's volume.
//
// The sequence is computed live from the existing rows for that month.
// This is fine at ≤ ~120 bookings/branch/month; if volume scales, swap
// in a per-month counter table.

import { getDb } from "./db";

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

/** Distinguish a ref ('R20260500001') from a numeric id ('1234') so the
 *  /r/[id] short-link route can resolve either. */
export function isBookingRef(s: string): boolean {
  return /^R\d{10,12}$/.test(s);
}
