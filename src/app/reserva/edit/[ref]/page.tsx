// Legacy redirect — edit page used to live at /reserva/edit/<ref>.
// We moved it to /reserva/<branch>/edit/<ref> (under the LIFF endpoint
// prefix and consistent with the claim flow). Anyone hitting the old
// URL — including LINE Flex cards sent before the move — gets sent to
// the new path with the correct branch slug looked up from the booking.
//
// Falls back to the home page if the ref doesn't exist or is malformed.

import { redirect } from "next/navigation";
import { getDb, type Booking, type Branch } from "@/lib/db";
import { isBookingRef } from "@/lib/reserva-ref";

export const dynamic = "force-dynamic";

export default function LegacyEditRedirect({ params }: { params: { ref: string } }) {
  const raw = decodeURIComponent(params.ref ?? "").trim();

  // Look up the booking to discover its branch slug. Accept both R-format
  // ref and numeric id (legacy fallback) — same logic as the new edit page.
  const db = getDb();
  let booking: Booking | undefined;
  const upperRaw = raw.toUpperCase();
  if (isBookingRef(upperRaw)) {
    booking = db.prepare("SELECT * FROM bookings WHERE ref_no = ?")
      .get(upperRaw) as Booking | undefined;
  } else {
    const numericId = Number(raw);
    if (Number.isInteger(numericId) && numericId > 0) {
      booking = db.prepare("SELECT * FROM bookings WHERE id = ?")
        .get(numericId) as Booking | undefined;
    }
  }
  if (!booking) redirect("/reserva");

  const branch = db.prepare("SELECT slug FROM branches WHERE id = ?")
    .get(booking.branch_id) as Pick<Branch, "slug"> | undefined;
  if (!branch) redirect("/reserva");

  const refDisplay = booking.ref_no ?? String(booking.id);
  redirect(`/reserva/${branch.slug}/edit/${refDisplay}`);
}
