import { requireUser } from "@/lib/auth";
import { getDb, type Branch, type Booking, type TableRow } from "@/lib/db";
import { todayBkk } from "@/lib/time";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { autoExpireStaleBookings } from "@/lib/stale-bookings";
import BookingsClient from "./BookingsClient";

export const dynamic = "force-dynamic";

type Row = Booking & { table_label: string | null };

// /admin/reserva/bookings
//
// Default view: chronological list from today forward, grouped by date.
// This stops admin from missing bookings on other dates because the date
// filter is set to "today only". The optional ?from=YYYY-MM-DD query param
// jumps the start of the list to a specific date — used by the date picker
// at the top — but never restricts to a single day.
export default function BookingsPage({ searchParams }: { searchParams: { from?: string } }) {
  const user = requireUser();
  const lang = getLang();
  if (!user.activeBranchId) return <div className="card">{t(lang, "admin.noBranchAccess")}</div>;
  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?").get(user.activeBranchId) as Branch;

  // Run stale-booking cleanup before reading the list — keeps the page
  // accurate even if the external cron isn't configured. Cheap (one
  // status filter + per-row time check; no LINE API calls).
  autoExpireStaleBookings();

  // Start date defaults to today. The date picker writes ?from=YYYY-MM-DD
  // to scroll to a specific date — but everything from that date onward
  // still renders (chronological).
  const fromDate = (searchParams.from && /^\d{4}-\d{2}-\d{2}$/.test(searchParams.from))
    ? searchParams.from
    : todayBkk();

  // Pending review bookings live on a dedicated /admin/reserva/pending page —
  // they're not shown here. We still pass an empty array to BookingsClient
  // so its existing prop API stays the same.
  const pendingBookings: Row[] = [];

  // Confirmed/seated/no-show/completed/cancelled bookings from `fromDate`
  // forward, grouped client-side by booking_date with a date header per
  // group. Cap at 60 days to avoid huge lists; admin can scroll the date
  // picker forward if they need to plan further.
  const horizonDate = new Date(`${fromDate}T00:00:00Z`);
  horizonDate.setUTCDate(horizonDate.getUTCDate() + 60);
  const horizonStr = horizonDate.toISOString().slice(0, 10);

  const upcomingBookings = db.prepare(`
    SELECT b.*, t.label AS table_label
    FROM bookings b LEFT JOIN tables t ON b.table_id = t.id
    WHERE b.branch_id = ?
      AND b.status != 'pending_review'
      AND b.booking_date >= ?
      AND b.booking_date <= ?
    ORDER BY b.booking_date ASC, b.booking_time ASC, b.created_at ASC
  `).all(branch.id, fromDate, horizonStr) as Row[];

  const allTables = db.prepare(
    "SELECT * FROM tables WHERE branch_id = ? AND active = 1 ORDER BY label"
  ).all(branch.id) as TableRow[];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t(lang, "admin.bookings.title")}</h1>
          <p className="text-sm text-slate-500">{branch.name}</p>
        </div>
        <form className="ml-auto flex items-center gap-2">
          <label className="text-sm">{t(lang, "admin.bookings.jumpToDate")}</label>
          <input type="date" name="from" defaultValue={fromDate} className="input w-auto" />
          <button className="btn-secondary">{t(lang, "admin.bookings.viewBtn")}</button>
        </form>
      </div>
      <a href={`/admin/reserva/timetable?date=${fromDate}`}
        className="inline-flex items-center gap-1 text-sm text-brand hover:underline">
        {t(lang, "admin.reserva.timetable.gridView")} →
      </a>
      <BookingsClient
        pendingBookings={pendingBookings}
        upcomingBookings={upcomingBookings}
        tables={allTables.map((row) => ({
          id: row.id, label: row.label, capacity: row.capacity
        }))}
        canEdit={true}
        branch={branch}
        fromDate={fromDate}
      />
    </div>
  );
}
