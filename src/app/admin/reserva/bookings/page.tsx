import { requireUser } from "@/lib/auth";
import { getDb, type Branch, type Booking, type TableRow } from "@/lib/db";
import { todayBkk } from "@/lib/time";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import BookingsClient from "./BookingsClient";

export const dynamic = "force-dynamic";

type Row = Booking & { table_label: string | null };

export default function BookingsPage({ searchParams }: { searchParams: { date?: string } }) {
  const user = requireUser();
  const lang = getLang();
  if (!user.activeBranchId) return <div className="card">{t(lang, "admin.noBranchAccess")}</div>;
  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?").get(user.activeBranchId) as Branch;
  const date = searchParams.date || todayBkk();

  const bookings = db.prepare(`
    SELECT b.*, t.label AS table_label
    FROM bookings b LEFT JOIN tables t ON b.table_id = t.id
    WHERE b.branch_id = ? AND b.booking_date = ?
    ORDER BY b.booking_time ASC, b.created_at ASC
  `).all(branch.id, date) as Row[];

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
          <label className="text-sm">{t(lang, "admin.bookings.dateLabel")}</label>
          <input type="date" name="date" defaultValue={date} className="input w-auto" />
          <button className="btn-secondary">{t(lang, "admin.bookings.viewBtn")}</button>
        </form>
      </div>
      <BookingsClient
        bookings={bookings}
        tables={allTables.map((row) => ({
          id: row.id, label: row.label, capacity: row.capacity
        }))}
        canEdit={true}
        branchOpenTime={branch.open_time}
        branchCloseTime={branch.close_time}
      />
    </div>
  );
}
