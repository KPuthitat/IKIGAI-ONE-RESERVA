import Link from "next/link";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getDb, type Branch, type Booking } from "@/lib/db";
import { todayBkk } from "@/lib/time";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { autoExpireStaleBookings } from "@/lib/stale-bookings";
import BookingsClient from "../../admin/reserva/bookings/BookingsClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "RESERVA · การจอง" };

type Row = Booking & { table_label: string | null };

// Staff view of the bookings list — same component as /admin/reserva/bookings
// but mounted under /staff. Uses the same BookingsClient (chronological list
// grouped by date, pending review at top, auto-refresh, etc.).
export default function StaffReservaPage({ searchParams }: { searchParams: { from?: string } }) {
  const user = requireUser();
  const lang = getLang();
  if (!user.activeBranchId) {
    return (
      <div className="card">
        <p className="text-slate-600 mb-3">{t(lang, "admin.notAssignedBranch")}</p>
        <Link href="/staff" className="btn-secondary">{t(lang, "common.back")}</Link>
      </div>
    );
  }
  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?").get(user.activeBranchId) as Branch;

  // Same auto-expire-on-load behaviour as the admin page so staff also
  // see fresh status without waiting on the external cron.
  autoExpireStaleBookings();

  const fromDate = (searchParams.from && /^\d{4}-\d{2}-\d{2}$/.test(searchParams.from))
    ? searchParams.from
    : todayBkk();

  // Pending review is admin-only (handled at /admin/reserva/pending) — staff
  // shouldn't be approving customer requests, just reading the day's lineup.
  const pendingBookings: Row[] = [];

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
  ).all(branch.id);

  return (
    <div className="space-y-4">
      <div>
        <Link href="/staff" className="text-sm text-slate-500 hover:text-brand">
          {t(lang, "staff.reserva.backToModules")}
        </Link>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t(lang, "staff.reserva.title")}</h1>
          <p className="text-sm text-slate-500">{branch.name}</p>
        </div>
        <form className="ml-auto flex items-center gap-2">
          <label className="text-sm">{t(lang, "admin.bookings.jumpToDate")}</label>
          <input type="date" name="from" defaultValue={fromDate} className="input w-auto" />
          <button className="btn-secondary">{t(lang, "staff.reserva.viewBtn")}</button>
        </form>
      </div>
      <BookingsClient
        pendingBookings={pendingBookings}
        upcomingBookings={upcomingBookings}
        tables={allTables as Array<{ id: number; label: string; capacity: number }>}
        canEdit={true}
        branch={branch}
        fromDate={fromDate}
      />
    </div>
  );
}
