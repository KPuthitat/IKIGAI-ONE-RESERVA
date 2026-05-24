// Short-link booking detail page — the QR code on the customer's LINE
// confirmation Flex card resolves here. Designed for staff who scan a
// customer's phone at the door: one screen shows the customer name, time,
// party size, table, and a single-tap button to mark them seated.
//
// URL pattern: /r/123  → booking id 123
// Auth: requires staff/admin login. Unauthenticated visitors get sent to
// /login and bounced back here after.

import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { getSessionUser } from "@/lib/auth";
import { getDb, type Booking } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { formatLongDate } from "@/lib/time";
import { isBookingRef } from "@/lib/reserva-ref";
import MarkSeatedButton from "./MarkSeatedButton";
import ClaimIceCreamPanel from "./ClaimIceCreamPanel";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "การจอง · IKIGAI OS RESERVA" };

type BookingRow = Booking & {
  table_label: string | null;
  branch_name: string;
};

export default function ShortLinkPage({ params }: { params: { id: string } }) {
  const user = getSessionUser();
  const lang = getLang();

  // Not logged in → bounce through /login with a return-to so they land
  // back here after authenticating.
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/r/${params.id}`)}`);
  }

  // The URL param can be either the new R-format ref ('R20260500001') or
  // a legacy numeric id ('123'). Look up by whichever the value matches.
  const raw = decodeURIComponent(params.id ?? "");
  const db = getDb();
  let booking: BookingRow | undefined;
  if (isBookingRef(raw)) {
    booking = db.prepare(`
      SELECT b.*, t.label AS table_label, br.name AS branch_name
      FROM bookings b
      LEFT JOIN tables t ON b.table_id = t.id
      LEFT JOIN branches br ON b.branch_id = br.id
      WHERE b.ref_no = ?
    `).get(raw) as BookingRow | undefined;
  } else {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) notFound();
    booking = db.prepare(`
      SELECT b.*, t.label AS table_label, br.name AS branch_name
      FROM bookings b
      LEFT JOIN tables t ON b.table_id = t.id
      LEFT JOIN branches br ON b.branch_id = br.id
      WHERE b.id = ?
    `).get(id) as BookingRow | undefined;
  }
  if (!booking) notFound();

  // Status pill colors
  const statusTone: Record<string, string> = {
    confirmed: "bg-sky-100 text-sky-700",
    seated: "bg-emerald-100 text-emerald-700",
    no_show: "bg-amber-100 text-amber-700",
    cancelled: "bg-slate-200 text-slate-500",
    completed: "bg-violet-100 text-violet-700"
  };

  return (
    <div className="min-h-screen bg-slate-100 flex items-start justify-center p-4">
      <div className="max-w-md w-full space-y-3">
        {/* Header bar matching the Flex card style */}
        <div className="rounded-t-2xl bg-ink-gradient text-white px-5 py-4">
          <div className="flex items-baseline justify-between text-[11px] tracking-wider">
            <span className="text-brand-light font-bold">IKIGAI OS</span>
            <span className="text-slate-300">RESERVA</span>
          </div>
          <h1 className="text-lg font-bold mt-1">
            {t(lang, "shortlink.title")} #{booking.ref_no ?? booking.id}
          </h1>
          <p className="text-xs text-slate-300 mt-0.5">{booking.branch_name}</p>
        </div>

        {/* Body */}
        <div className="bg-white rounded-2xl shadow border border-slate-200 p-5 space-y-4 -mt-3 relative z-10">
          <div>
            <div className="text-2xl font-bold text-slate-800">
              {booking.customer_name}
            </div>
            {booking.customer_phone && (
              <a href={`tel:${booking.customer_phone}`} className="text-sm text-brand">
                {booking.customer_phone}
              </a>
            )}
          </div>

          <div className="space-y-2 text-sm border-t border-slate-100 pt-3">
            <Row
              label={t(lang, "shortlink.row.date")}
              value={formatLongDate(booking.booking_date, lang)}
            />
            <Row
              label={t(lang, "shortlink.row.time")}
              value={booking.booking_time}
              valueBold
            />
            <Row
              label={t(lang, "shortlink.row.party")}
              value={`${booking.party_size} ${t(lang, "shortlink.guestsUnit")}`}
              valueBold
            />
            <Row
              label={t(lang, "shortlink.row.table")}
              value={booking.table_label ?? t(lang, "shortlink.tableNotAssigned")}
              valueColor={booking.table_label ? undefined : "text-rose-600"}
              valueBold
            />
            <Row
              label={t(lang, "shortlink.row.status")}
              valueNode={
                <span className={`text-[11px] px-2 py-0.5 rounded font-medium ${statusTone[booking.status] ?? "bg-slate-100 text-slate-600"}`}>
                  {t(lang, `status.${booking.status}`)}
                </span>
              }
            />
          </div>

          {booking.notes && (
            <div className="text-sm border-t border-slate-100 pt-3">
              <div className="text-xs text-slate-500 mb-1">
                {t(lang, "shortlink.row.notes")}
              </div>
              <div className="text-slate-700 whitespace-pre-wrap">{booking.notes}</div>
            </div>
          )}

          {/* Primary action */}
          {booking.status === "confirmed" ? (
            <MarkSeatedButton bookingId={booking.id} lang={lang} />
          ) : booking.status === "seated" ? (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-center text-sm text-emerald-700 font-medium">
              ✓ {t(lang, "shortlink.alreadySeated")}
            </div>
          ) : booking.status === "cancelled" ? (
            <div className="bg-slate-100 border border-slate-200 rounded-lg p-3 text-center text-sm text-slate-500">
              {t(lang, "shortlink.cancelled")}
            </div>
          ) : null}

          {/* Redemption panel — only render when the booking carries
              a redemption_status of 'eligible' / 'claimed' / 'expired'.
              'not_eligible' (returning customer) and NULL (legacy)
              hide the panel entirely. */}
          {(booking.redemption_status === "eligible"
            || booking.redemption_status === "claimed"
            || booking.redemption_status === "expired") && (
            <ClaimIceCreamPanel
              bookingId={booking.id}
              code={booking.verification_code}
              initialStatus={booking.redemption_status}
              claimedAt={booking.redeemed_at}
              lang={lang}
            />
          )}

          <div className="text-xs text-center pt-2 border-t border-slate-100">
            <Link href="/staff/reserva" className="text-slate-500 hover:text-brand">
              {t(lang, "shortlink.viewAll")} →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({
  label, value, valueNode, valueBold, valueColor
}: {
  label: string;
  value?: string;
  valueNode?: React.ReactNode;
  valueBold?: boolean;
  valueColor?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      {valueNode ? valueNode : (
        <span className={`${valueBold ? "font-bold" : ""} ${valueColor ?? "text-slate-800"}`}>
          {value}
        </span>
      )}
    </div>
  );
}
