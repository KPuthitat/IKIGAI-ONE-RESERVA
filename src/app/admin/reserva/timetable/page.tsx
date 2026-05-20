// Timetable grid — table × time view of bookings for a single day.
//
// Vertical axis: tables grouped by zone (zone display_order then table label).
// Horizontal axis: 30-min slots from branch.open_time → branch.close_time.
// Each booking renders as a colored block spanning its duration.
// Clicking an empty cell opens the walk-in modal pre-filled with that
// table + time. Clicking a booking opens /r/<ref> in a new tab.

import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getDb, type Branch, type Booking, type TableRow, type Zone } from "@/lib/db";
import { todayBkk } from "@/lib/time";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import TimetableClient from "./TimetableClient";
import TableManager from "./TableManager";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "ตารางจอง · RESERVA" };

export default function TimetablePage({ searchParams }: { searchParams: { date?: string } }) {
  const user = requireUser();
  const lang = getLang();
  if (!user.activeBranchId) {
    return <div className="card">{t(lang, "admin.noBranchAccess")}</div>;
  }
  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch;
  const date = searchParams.date || todayBkk();

  // Active tables (the timetable hides inactive ones — no point showing
  // disabled tables; admin manages them on the floor-plan page)
  const tables = db.prepare(`
    SELECT * FROM tables
    WHERE branch_id = ? AND active = 1
    ORDER BY label
  `).all(branch.id) as TableRow[];

  // Active zones, ordered by display_order then name
  const zones = db.prepare(`
    SELECT * FROM zones
    WHERE branch_id = ? AND active = 1
    ORDER BY display_order, name
  `).all(branch.id) as Zone[];

  // Bookings on this date — exclude cancelled (they shouldn't render).
  // no_show stays so staff can see what was missed.
  const bookings = db.prepare(`
    SELECT * FROM bookings
    WHERE branch_id = ? AND booking_date = ?
      AND status IN ('confirmed','seated','no_show','completed')
    ORDER BY booking_time ASC
  `).all(branch.id, date) as Booking[];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">
            {t(lang, "admin.reserva.timetable.title")}
          </h1>
          <p className="text-sm text-slate-500">{branch.name}</p>
        </div>
        <form className="ml-auto flex items-center gap-2">
          <label className="text-sm">{t(lang, "admin.bookings.dateLabel")}</label>
          <input type="date" name="date" defaultValue={date} className="input w-auto" />
          <button className="btn-secondary">{t(lang, "admin.bookings.viewBtn")}</button>
        </form>
      </div>

      <div className="text-xs text-slate-500 flex items-center gap-3 flex-wrap">
        <Link href="/admin/reserva/bookings" className="text-brand hover:underline">
          ← {t(lang, "admin.reserva.timetable.listView")}
        </Link>
        <Legend lang={lang} />
      </div>

      <TimetableClient
        branch={branch}
        zones={zones}
        tables={tables}
        bookings={bookings}
        date={date}
      />

      {/* Management panel sits BELOW the grid so the timetable itself
          is the first thing admin sees on load. */}
      <TableManager branch={branch} tables={tables} zones={zones} />
    </div>
  );
}

function Legend({ lang }: { lang: "th" | "en" }) {
  const items: Array<{ key: string; cls: string }> = [
    { key: "admin.reserva.timetable.legend.confirmed", cls: "bg-sky-200" },
    { key: "admin.reserva.timetable.legend.seated", cls: "bg-emerald-200" },
    { key: "admin.reserva.timetable.legend.walkin", cls: "bg-amber-200" },
    { key: "admin.reserva.timetable.legend.noShow", cls: "bg-rose-200" },
    { key: "admin.reserva.timetable.legend.completed", cls: "bg-violet-200" }
  ];
  return (
    <div className="inline-flex items-center gap-3 flex-wrap">
      {items.map((it) => (
        <span key={it.key} className="inline-flex items-center gap-1">
          <span className={`inline-block w-3 h-3 rounded ${it.cls}`}></span>
          {t(lang, it.key)}
        </span>
      ))}
    </div>
  );
}
