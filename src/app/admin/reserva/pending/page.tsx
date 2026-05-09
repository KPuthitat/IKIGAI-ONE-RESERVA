// /admin/reserva/pending — dedicated page for "รายการจองผ่านระบบ"
//
// Customer-submitted bookings that arrived via the public booking form
// land here as status='pending_review'. Admin assigns a table + clicks
// Confirm-and-notify, then the booking moves over to /admin/reserva/bookings
// (the "all bookings" view) and the customer gets the Flex card with QR.
//
// Splitting this off the main bookings page lets admin focus on the
// queue without scrolling past confirmed bookings, and keeps the badge
// count meaningful (zero bookings here = inbox zero).

import { requireUser } from "@/lib/auth";
import { getDb, type Branch, type Booking, type TableRow } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { autoExpireStaleBookings } from "@/lib/stale-bookings";
import { isTableFree } from "@/lib/table-allocator";
import PendingClient from "./PendingClient";

export const dynamic = "force-dynamic";

type Row = Booking & {
  table_label: string | null;
  /** Tables available at this booking's specific time slot. The pending
   *  client filters its dropdown by this list so admin can't pick a table
   *  that's already booked in the same window. */
  available_table_ids: number[];
};

export default function PendingPage() {
  const user = requireUser();
  const lang = getLang();
  if (!user.activeBranchId) {
    return <div className="card">{t(lang, "admin.noBranchAccess")}</div>;
  }

  // Auto-expire stale rows so the queue doesn't show bookings the cron
  // already moved past 30-min-late cutoff.
  autoExpireStaleBookings();

  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch;

  const rawPending = db.prepare(`
    SELECT b.*, t.label AS table_label
    FROM bookings b LEFT JOIN tables t ON b.table_id = t.id
    WHERE b.branch_id = ? AND b.status = 'pending_review'
    ORDER BY b.created_at ASC
  `).all(branch.id) as Array<Booking & { table_label: string | null }>;

  const allTables = db.prepare(
    "SELECT * FROM tables WHERE branch_id = ? AND active = 1 ORDER BY label"
  ).all(branch.id) as TableRow[];

  // Per-pending-booking availability check — for each pending row, compute
  // which active tables are free at that specific time slot. The result
  // becomes available_table_ids on each row so the client dropdown shows
  // only valid options. Excludes the pending booking itself from the
  // overlap check (its table_id is null so it doesn't matter, but we keep
  // the parameter for symmetry with the confirmed-edit case).
  const pendingBookings: Row[] = rawPending.map((b) => ({
    ...b,
    available_table_ids: allTables
      .filter((tb) =>
        isTableFree({
          branchId: branch.id,
          tableId: tb.id,
          date: b.booking_date,
          time: b.booking_time,
          durationMinutes: b.duration_minutes,
          excludeBookingId: b.id
        })
      )
      .map((tb) => tb.id)
  }));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t(lang, "admin.nav.pendingReview")}</h1>
        <p className="text-sm text-slate-500">{branch.name}</p>
      </div>
      <PendingClient
        pendingBookings={pendingBookings}
        tables={allTables.map((row) => ({
          id: row.id, label: row.label, capacity: row.capacity
        }))}
      />
    </div>
  );
}
