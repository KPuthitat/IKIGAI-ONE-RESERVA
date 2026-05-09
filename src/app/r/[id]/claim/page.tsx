// Legacy redirect — claim used to live at /r/<ref>/claim, but that URL
// was outside the LIFF endpoint URL prefix per branch, so liff.init()
// threw with "the URL is not the LIFF endpoint" and customers saw
// "ระบบขัดข้อง". Claim now lives under /reserva/<branch>/claim/<ref>
// (under the LIFF endpoint). Anyone hitting the old URL gets redirected.

import { redirect, notFound } from "next/navigation";
import { getDb, type Booking, type Branch } from "@/lib/db";
import { isBookingRef } from "@/lib/reserva-ref";

export const dynamic = "force-dynamic";

export default function LegacyClaimRedirect({ params }: { params: { id: string } }) {
  const ref = decodeURIComponent(params.id ?? "");
  if (!isBookingRef(ref)) notFound();

  const db = getDb();
  const booking = db.prepare("SELECT branch_id FROM bookings WHERE ref_no = ?")
    .get(ref) as Pick<Booking, "branch_id"> | undefined;
  if (!booking) notFound();

  const branch = db.prepare("SELECT slug FROM branches WHERE id = ?")
    .get(booking.branch_id) as Pick<Branch, "slug"> | undefined;
  if (!branch) notFound();

  redirect(`/reserva/${branch.slug}/claim/${ref}`);
}
