import Link from "next/link";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import WalkInClient, { type TableOpt, type RecentVisit } from "./WalkInClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Walk-in · RESERVA" };

// Staff records a walk-in customer (the ones who showed up without
// going through the LINE booking flow). Same first-time check as
// online bookings → if the phone hasn't been seen before, the system
// shows a verification code + lets staff claim the free ice cream
// right from this screen.
export default function WalkInPage() {
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
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch;

  // Active tables for the picker (optional — walk-in may seat anywhere).
  const tables = db.prepare(`
    SELECT id, label
    FROM tables
    WHERE branch_id = ? AND active = 1
    ORDER BY label
  `).all(branch.id) as TableOpt[];

  // Today's walk-ins for the staff to see what's already in the
  // system — also helps avoid double-entry. Limited to 15 most
  // recent rows in this branch today.
  const todayStart = new Date(new Date(Date.now() + 7 * 60 * 60 * 1000)
    .toISOString().slice(0, 10) + "T00:00:00+07:00").toISOString();
  const recent = db.prepare(`
    SELECT w.id, w.guest_name, w.phone, w.party_size, w.visited_at,
           w.verification_code, w.redemption_status, w.first_time,
           t.label AS table_label,
           u.display_name AS recorded_by_name
    FROM walk_in_visits w
    LEFT JOIN tables t ON t.id = w.table_id
    LEFT JOIN users u ON u.id = w.recorded_by_user_id
    WHERE w.branch_id = ? AND w.visited_at >= ?
    ORDER BY w.visited_at DESC
    LIMIT 15
  `).all(branch.id, todayStart) as RecentVisit[];

  return (
    <div className="space-y-4">
      <div>
        <Link href="/staff/reserva" className="text-sm text-slate-500 hover:text-brand">
          ← {t(lang, "staff.walkIn.backToReserva")}
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "staff.walkIn.title")}
        </h1>
        <p className="text-sm text-slate-500">{branch.name}</p>
      </div>
      <WalkInClient lang={lang} tables={tables} recent={recent} />
    </div>
  );
}
