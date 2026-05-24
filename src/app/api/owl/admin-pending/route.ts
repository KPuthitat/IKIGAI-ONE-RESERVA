import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// GET /api/owl/admin-pending
//
// Powers the floating Owl assistant's "งานค้าง" greeting. The Owl
// pings this endpoint when it opens (and once on page mount, so the
// badge dot can light up before the user even taps the owl). Returns
// a small bundle of items the active-branch admin should look at.
//
// Scope is the admin's currently-active branch — never company-wide.
// An admin who switches to AT-HOME sees only AT-HOME's queue, even
// if NAMA has 20 pending bookings. Super admin gets the same scoping
// because we want a focused inbox; they can flip branches manually.
//
// Each item is { kind, count, href } so the Owl can render a generic
// list without hard-coding labels (labels live in i18n on the client).
//
// Empty array when nothing is pending — keeps the response cheap so
// the polling overhead is negligible.

type PendingItem = {
  kind:
    | "pending_review_bookings"      // new bookings waiting for table + confirm
    | "confirmed_no_table"           // bookings already confirmed but table_id is NULL
    | "shift_unlock_requests"        // staff asking to edit a locked shift report
    | "leave_requests";              // pending leave approvals
  count: number;
  href: string;
};

export type OwlAdminPendingResponse = {
  user_name: string;
  user_prefix: string | null;
  branch_name: string | null;
  total: number;
  items: PendingItem[];
};

export async function GET() {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  // Owl assistant is admin-only — staff don't manage queues. Returning
  // 200 with empty items keeps the client simple (no error branch).
  const isAdmin = user.role === "admin" || user.role === "super_admin";
  if (!isAdmin || !user.activeBranchId) {
    return NextResponse.json({
      user_name: user.display_name,
      user_prefix: user.title_prefix,
      branch_name: null,
      total: 0,
      items: []
    } as OwlAdminPendingResponse);
  }

  const db = getDb();
  const branchId = user.activeBranchId;
  const items: PendingItem[] = [];

  // 1. Pending-review bookings — the most actionable queue.
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM bookings
      WHERE branch_id = ? AND status = 'pending_review'
    `).get(branchId) as { n: number };
    if (row.n > 0) {
      items.push({
        kind: "pending_review_bookings",
        count: row.n,
        href: "/admin/reserva/pending"
      });
    }
  } catch { /* table may not exist on a fresh install — ignore */ }

  // 2. Confirmed bookings missing a table — the recent bug. Show
  //    only today + future so old data doesn't permanently nag.
  try {
    const today = new Date(Date.now() + 7 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM bookings
      WHERE branch_id = ?
        AND status IN ('confirmed','seated')
        AND table_id IS NULL
        AND booking_date >= ?
    `).get(branchId, today) as { n: number };
    if (row.n > 0) {
      items.push({
        kind: "confirmed_no_table",
        count: row.n,
        href: "/admin/reserva/bookings"
      });
    }
  } catch { /* ignore */ }

  // 3. Shift unlock requests — staff asking to edit a locked report.
  //    Branch is on the linked daily_report row, not the request itself.
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS n
      FROM shift_unlock_requests sur
      JOIN daily_reports dr ON dr.id = sur.daily_report_id
      WHERE dr.branch_id = ? AND sur.status = 'pending'
    `).get(branchId) as { n: number };
    if (row.n > 0) {
      items.push({
        kind: "shift_unlock_requests",
        count: row.n,
        href: "/admin/persona/shift-reports"
      });
    }
  } catch { /* table may not exist yet — ignore */ }

  // 4. Pending leave requests for staff assigned to this branch.
  //    leave_requests has user_id only, no branch_id, so filter via
  //    the user_branches mapping.
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS n
      FROM leave_requests lr
      WHERE lr.status = 'pending'
        AND lr.user_id IN (
          SELECT user_id FROM user_branches WHERE branch_id = ?
        )
    `).get(branchId) as { n: number };
    if (row.n > 0) {
      items.push({
        kind: "leave_requests",
        count: row.n,
        href: "/admin/persona/leave"
      });
    }
  } catch { /* ignore */ }

  const branch = db.prepare("SELECT name FROM branches WHERE id = ?")
    .get(branchId) as { name: string } | undefined;

  const total = items.reduce((s, it) => s + it.count, 0);
  return NextResponse.json({
    user_name: user.display_name,
    user_prefix: user.title_prefix,
    branch_name: branch?.name ?? null,
    total,
    items
  } as OwlAdminPendingResponse);
}
