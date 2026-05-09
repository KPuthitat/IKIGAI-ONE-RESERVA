// Customer-facing edit / cancel page.
//
// Linked from the LINE Flex card via "ปรับเปลี่ยน / ยกเลิกการจอง".
// Public — no login required, knowledge of the ref is the secret.
// Allowed up to 2 hours before booking_time. Within the 2-hour window
// the page becomes read-only and asks the customer to call the
// restaurant directly.

import Link from "next/link";
import type { Metadata } from "next";
import { getDb, type Booking, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { formatLongDate } from "@/lib/time";
import { isBookingRef } from "@/lib/reserva-ref";
import LangToggle from "../../../LangToggle";
import Footer from "../../../Footer";
import EditBookingForm from "./EditBookingForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "ปรับเปลี่ยนการจอง · RESERVA" };

// Customer can edit up to 60 min before the booking time. Beyond that
// the form locks to a read-only banner asking them to call the restaurant
// directly. Was 120 min — relaxed to 60 to give more legitimate
// last-minute change room. The 60-min floor still protects the kitchen
// from same-time-slot churn.
const EDIT_CUTOFF_MINUTES = 60;

type Row = Booking & { branch_name: string; branch_open_time: string; branch_close_time: string };

// Server logs every hit so we can see what URL/ref the customer
// actually clicks. Helpful when 404s are reported and we don't know
// whether the URL was malformed, the booking didn't exist, or the
// route wasn't found at all (the latter would never reach this code).
function logHit(rawRef: string, found: boolean): void {
  try {
    console.log(`[edit-page] ref=${JSON.stringify(rawRef)} found=${found}`);
  } catch { /* ignore */ }
}

export default function EditBookingPage({ params }: { params: { ref: string } }) {
  const lang = getLang();
  const raw = decodeURIComponent(params.ref ?? "").trim();

  // The Flex card builds its URL with `bookingRef ?? String(bookingId)` —
  // so legacy bookings without ref_no would land here with a numeric id
  // like "/reserva/edit/42". Accept both formats so the button never
  // 404s on the customer. Look up by ref_no when the param is in the
  // R-format, fall back to numeric id otherwise. Case-insensitive on
  // the R-prefix in case LINE or some shortener lower-cases the URL.
  const db = getDb();
  let booking: Row | undefined;
  const upperRaw = raw.toUpperCase();
  if (isBookingRef(upperRaw)) {
    booking = db.prepare(`
      SELECT b.*, br.name AS branch_name,
             br.open_time AS branch_open_time, br.close_time AS branch_close_time
      FROM bookings b
      LEFT JOIN branches br ON b.branch_id = br.id
      WHERE b.ref_no = ?
    `).get(upperRaw) as Row | undefined;
  } else {
    const numericId = Number(raw);
    if (Number.isInteger(numericId) && numericId > 0) {
      booking = db.prepare(`
        SELECT b.*, br.name AS branch_name,
               br.open_time AS branch_open_time, br.close_time AS branch_close_time
        FROM bookings b
        LEFT JOIN branches br ON b.branch_id = br.id
        WHERE b.id = ?
      `).get(numericId) as Row | undefined;
    }
  }
  logHit(raw, !!booking);

  // No booking → render a friendly error page instead of the bare
  // Next.js 404. Lets the customer understand what happened and gives
  // us (admin) a clear screen to look at when debugging.
  if (!booking) {
    return (
      <div className="min-h-screen flex flex-col bg-slate-100">
        <main className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md w-full card text-center">
            <div className="text-3xl font-bold text-slate-300 mb-2">?</div>
            <h1 className="text-lg font-bold text-slate-800">
              {t(lang, "edit.err.notFoundTitle")}
            </h1>
            <p className="text-sm text-slate-600 mt-2">
              {t(lang, "edit.err.notFoundBody")}
            </p>
            <p className="text-xs text-slate-400 mt-3 font-mono break-all">
              ref: {raw || "(empty)"}
            </p>
            <Link href="/reserva" className="btn-secondary inline-block mt-4">
              {t(lang, "common.back")}
            </Link>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  // Compute minutes until booking_time (Bangkok). Compare against the
  // 2-hour cutoff to decide whether the form is editable.
  const bookingTs = new Date(`${booking.booking_date}T${booking.booking_time}:00+07:00`).getTime();
  const minutesUntil = Math.floor((bookingTs - Date.now()) / 60000);
  const isCancelled = booking.status === "cancelled";
  const isPast = minutesUntil < 0;
  const withinCutoff = minutesUntil >= 0 && minutesUntil < EDIT_CUTOFF_MINUTES;
  const editable = !isCancelled && !isPast && !withinCutoff;

  // Re-fetch the branch to pass full lunch / closed-day data into the form
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(booking.branch_id) as Branch;

  return (
    <div className="min-h-screen flex flex-col bg-slate-100">
      <main className="flex-1">
        <div className="bg-ink-gradient text-white py-6 px-6">
          <div className="max-w-2xl mx-auto flex items-center justify-between gap-4">
            <Link href="/reserva" className="inline-block hover:opacity-80 transition-opacity">
              <div className="brand-wordmark text-white text-xl">
                IKIGAI OS <span className="text-white/60 font-normal text-sm tracking-normal">· RESERVA</span>
              </div>
            </Link>
            <LangToggle variant="dark" />
          </div>
        </div>
        <div className="max-w-2xl mx-auto p-4 sm:p-6 space-y-4">
          <header>
            <h1 className="text-2xl font-bold text-slate-800">
              {t(lang, "edit.title")}
            </h1>
            <p className="text-slate-500 text-sm mt-1">
              {booking.branch_name} · #{booking.ref_no}
            </p>
          </header>

          {/* Status banner */}
          {isCancelled ? (
            <div className="card border-l-4 border-slate-400 bg-slate-50">
              <div className="font-semibold text-slate-700">
                {t(lang, "edit.banner.cancelledTitle")}
              </div>
              <p className="text-sm text-slate-600 mt-1">
                {t(lang, "edit.banner.cancelledBody")}
              </p>
            </div>
          ) : isPast ? (
            <div className="card border-l-4 border-slate-400 bg-slate-50">
              <div className="font-semibold text-slate-700">
                {t(lang, "edit.banner.pastTitle")}
              </div>
              <p className="text-sm text-slate-600 mt-1">
                {t(lang, "edit.banner.pastBody")}
              </p>
            </div>
          ) : withinCutoff ? (
            <div className="card border-l-4 border-amber-400 bg-amber-50">
              <div className="font-semibold text-amber-800">
                {t(lang, "edit.banner.cutoffTitle")}
              </div>
              <p className="text-sm text-amber-700 mt-1">
                {t(lang, "edit.banner.cutoffBody", { date: formatLongDate(booking.booking_date, lang), time: booking.booking_time })}
              </p>
            </div>
          ) : (
            <div className="card border-l-4 border-emerald-400 bg-emerald-50/40">
              <div className="font-semibold text-slate-800">
                {t(lang, "edit.banner.editableTitle")}
              </div>
              <p className="text-sm text-slate-600 mt-1">
                {t(lang, "edit.banner.editableBody", { date: formatLongDate(booking.booking_date, lang), time: booking.booking_time })}
              </p>
            </div>
          )}

          {/* Read-only summary always visible */}
          <div className="card space-y-2 text-sm">
            <SummaryRow label={t(lang, "edit.row.name")} value={booking.customer_name} />
            <SummaryRow label={t(lang, "edit.row.phone")} value={booking.customer_phone || "—"} />
            <SummaryRow label={t(lang, "edit.row.party")}
              value={`${booking.party_size} ${t(lang, "edit.guestsUnit")}`} />
            <SummaryRow label={t(lang, "edit.row.date")} value={formatLongDate(booking.booking_date, lang)} />
            <SummaryRow label={t(lang, "edit.row.time")} value={booking.booking_time} />
            {booking.notes && (
              <SummaryRow label={t(lang, "edit.row.notes")} value={booking.notes} />
            )}
          </div>

          {/* Editable form (or nothing if outside the editable window) */}
          {editable && (
            <EditBookingForm
              ref_no={booking.ref_no!}
              branch={branch}
              initial={{
                party_size: booking.party_size,
                booking_date: booking.booking_date,
                booking_time: booking.booking_time,
                notes: booking.notes ?? ""
              }}
            />
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-800 text-right font-medium">{value}</span>
    </div>
  );
}
