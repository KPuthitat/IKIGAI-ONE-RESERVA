// Customer-facing "claim my booking" page — opened from the link admin
// pasted into the LINE OA chat after using +จองผ่านไลน์. The page initializes
// LIFF for the right branch, captures the customer's LINE userId silently,
// and sends the Flex confirmation card back to them.
//
// URL: /reserva/<branch>/claim/<ref>
//   Lives under /reserva/<branch>/* on purpose — the LIFF endpoint URL
//   for each branch is configured to that prefix, and LIFF SDK only
//   inits successfully on URLs under the registered endpoint. Putting
//   claim outside that prefix (the old /r/<ref>/claim path) caused
//   liff.init() to throw and the page to show "ระบบขัดข้อง".
//
// No login required — the claim link itself IS the credential. See
// /api/bookings/claim/route.ts for the back-end handler.

import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getDb, type Booking, type Branch } from "@/lib/db";
import { getChannelByCode } from "@/lib/messaging-channels";
import { isBookingRef } from "@/lib/reserva-ref";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { formatLongDate } from "@/lib/time";
import ClaimClient from "./ClaimClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "รับ QR Code · IKIGAI OS RESERVA"
};

export default function ClaimPage({
  params
}: {
  params: { branch: string; ref: string };
}) {
  const lang = getLang();
  const ref = decodeURIComponent(params.ref ?? "");
  const branchSlug = decodeURIComponent(params.branch ?? "");
  if (!isBookingRef(ref)) notFound();

  const db = getDb();
  const booking = db.prepare("SELECT * FROM bookings WHERE ref_no = ?")
    .get(ref) as Booking | undefined;
  if (!booking) notFound();

  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(booking.branch_id) as Branch | undefined;
  if (!branch) notFound();

  // The branch slug in the URL must match the booking's actual branch —
  // prevents an admin from accidentally pasting a NAMA booking ref into a
  // HYPOPLARAEMIA claim URL (or vice versa) and having LIFF init the wrong
  // channel. Compare case-insensitively for safety.
  if (branchSlug.toLowerCase() !== branch.slug.toLowerCase()) notFound();

  // LIFF id from the branch's RESERVA messaging channel — falls back to null
  // if not configured. ClaimClient handles missing-LIFF gracefully (shows a
  // manual fallback explaining what happened).
  const channel = getChannelByCode(branch.slug);
  const liffId = channel?.liff_id ?? null;

  return (
    <div className="min-h-screen bg-slate-100 flex items-start justify-center p-4">
      <div className="max-w-md w-full space-y-3">
        <div className="rounded-t-2xl bg-ink-gradient text-white px-5 py-4">
          <div className="flex items-baseline justify-between text-[11px] tracking-wider">
            <span className="text-brand-light font-bold">IKIGAI OS</span>
            <span className="text-slate-300">RESERVA</span>
          </div>
          <h1 className="text-lg font-bold mt-1">
            {t(lang, "claim.title")} #{booking.ref_no ?? booking.id}
          </h1>
          <p className="text-xs text-slate-300 mt-0.5">{branch.name}</p>
        </div>

        <div className="bg-white rounded-2xl shadow border border-slate-200 p-5 space-y-4 -mt-3 relative z-10">
          <div className="text-sm text-slate-600 space-y-1">
            <div>
              <span className="text-slate-500">{t(lang, "claim.row.name")}: </span>
              <span className="font-medium">{booking.customer_name}</span>
            </div>
            <div>
              <span className="text-slate-500">{t(lang, "claim.row.dateTime")}: </span>
              <span className="font-medium">
                {formatLongDate(booking.booking_date, lang)} · {booking.booking_time}
              </span>
            </div>
            <div>
              <span className="text-slate-500">{t(lang, "claim.row.party")}: </span>
              <span className="font-medium">
                {booking.party_size} {t(lang, "shortlink.guestsUnit")}
              </span>
            </div>
          </div>

          <ClaimClient
            ref_no={booking.ref_no ?? ""}
            branchSlug={branch.slug}
            liffId={liffId}
            alreadyLinked={!!booking.line_user_id}
            lang={lang}
          />
        </div>
      </div>
    </div>
  );
}
