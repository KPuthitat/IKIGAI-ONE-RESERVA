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
import PendingClient from "./PendingClient";

export const dynamic = "force-dynamic";

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

  const pendingBookings = db.prepare(`
    SELECT b.*, t.label AS table_label
    FROM bookings b LEFT JOIN tables t ON b.table_id = t.id
    WHERE b.branch_id = ? AND b.status = 'pending_review'
    ORDER BY b.created_at ASC
  `).all(branch.id) as Array<Booking & { table_label: string | null }>;

  // Tables for the per-card picker — admin MUST pick one before
  // confirming so customers never get a Flex card without an actual
  // table to sit at. Active tables only.
  const allTables = db.prepare(
    "SELECT * FROM tables WHERE branch_id = ? AND active = 1 ORDER BY label"
  ).all(branch.id) as TableRow[];

  // ── Overnight summary ─────────────────────────────────────────────
  // Cutoff = yesterday's close_time in Bangkok, expressed as UTC ISO
  // so it lines up with SQLite's created_at strings (stored UTC).
  // "Overnight" means "anything that came in after we shut last night",
  // which is exactly the inbox a morning shift needs to triage.
  const ctMatch = (branch.close_time || "22:00").match(/^(\d{2}):(\d{2})$/);
  const closeH = ctMatch ? Number(ctMatch[1]) : 22;
  const closeM = ctMatch ? Number(ctMatch[2]) : 0;
  const bkkNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const yesterdayCloseUtc = new Date(Date.UTC(
    bkkNow.getUTCFullYear(), bkkNow.getUTCMonth(), bkkNow.getUTCDate() - 1,
    closeH - 7, closeM, 0
  ));
  const overnight = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(party_size), 0) AS seats
    FROM bookings
    WHERE branch_id = ? AND status = 'pending_review'
      AND datetime(created_at) >= datetime(?)
  `).get(branch.id, yesterdayCloseUtc.toISOString()) as { n: number; seats: number };
  const sinceLabel = `${String(closeH).padStart(2, "0")}:${String(closeM).padStart(2, "0")}`;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t(lang, "admin.nav.pendingReview")}</h1>
        <p className="text-sm text-slate-500">{branch.name}</p>
      </div>

      {overnight.n > 0 && (
        <div className="rounded-2xl border border-indigo-200 bg-indigo-50/60 p-4">
          <div className="font-bold text-indigo-900">
            {t(lang, "admin.pending.overnight.title")}
          </div>
          <div className="text-sm text-indigo-700 mt-1">
            {t(lang, "admin.pending.overnight.summary", {
              n: overnight.n, seats: overnight.seats, since: sinceLabel
            })}
          </div>
          <div className="text-xs text-indigo-700/70 mt-1">
            ↓ {t(lang, "admin.pending.overnight.cta")}
          </div>
        </div>
      )}

      <PendingClient
        pendingBookings={pendingBookings}
        tables={allTables.map((row) => ({
          id: row.id, label: row.label, capacity: row.capacity
        }))}
      />
    </div>
  );
}
