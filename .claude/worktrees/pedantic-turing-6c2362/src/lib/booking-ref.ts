// Pure helpers for the booking reference format.
//
// This module deliberately has zero imports so it's safe to use from
// client components. The server-only counterpart (lib/reserva-ref.ts)
// generates new refs and pulls in better-sqlite3 — webpack would drag
// node:fs/path into the client bundle if those two helpers were in the
// same file.

/** Booking refs look like 'R20260500001'. The numeric tail is YYYYMM
 *  followed by a 4-digit sequence; we accept 4-6 digits for forward
 *  compat in case volume ever exceeds 9999/month. */
export function isBookingRef(s: string): boolean {
  return /^R\d{10,12}$/.test(s);
}
