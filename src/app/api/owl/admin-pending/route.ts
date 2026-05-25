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

/** One group in the owl's "งานค้าง" digest — pending items for a
 *  single branch the current admin oversees. The owl renders one
 *  card per branch so admin can act on each independently. */
export type OwlBranchGroup = {
  branch_id: number;
  branch_name: string;
  branch_slug: string;
  total: number;
  items: PendingItem[];
};

export type OwlAdminPendingResponse = {
  user_name: string;
  user_prefix: string | null;
  total: number;          // sum across ALL branches
  branches: OwlBranchGroup[];
};

export async function GET() {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  // Owl assistant is admin-only — staff don't manage queues. Returning
  // 200 with empty branches keeps the client simple (no error branch).
  const isAdmin = user.role === "admin" || user.role === "super_admin";
  if (!isAdmin) {
    return NextResponse.json({
      user_name: user.display_name,
      user_prefix: user.title_prefix,
      total: 0,
      branches: []
    } as OwlAdminPendingResponse);
  }

  const db = getDb();

  // Universal owl (2026-05) — instead of just the active branch,
  // surface pending work across every branch the admin oversees so
  // they don't need to switch branches just to spot what's waiting.
  // Super-admin gets every branch in the company; branch-admin gets
  // only the branches in their adminBranchIds list.
  let branchRows: Array<{ id: number; slug: string; name: string }>;
  if (user.role === "super_admin") {
    branchRows = db.prepare(`
      SELECT id, slug, name FROM branches
      WHERE status != 'closed'
      ORDER BY display_order, name
    `).all() as Array<{ id: number; slug: string; name: string }>;
  } else {
    if (user.adminBranchIds.length === 0) {
      return NextResponse.json({
        user_name: user.display_name,
        user_prefix: user.title_prefix,
        total: 0,
        branches: []
      } as OwlAdminPendingResponse);
    }
    const placeholders = user.adminBranchIds.map(() => "?").join(",");
    branchRows = db.prepare(`
      SELECT id, slug, name FROM branches
      WHERE id IN (${placeholders}) AND status != 'closed'
      ORDER BY display_order, name
    `).all(...user.adminBranchIds) as Array<{ id: number; slug: string; name: string }>;
  }

  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  const branches: OwlBranchGroup[] = [];
  for (const branch of branchRows) {
    const items: PendingItem[] = [];

    // 1. Pending-review bookings — the most actionable queue.
    try {
      const row = db.prepare(`
        SELECT COUNT(*) AS n FROM bookings
        WHERE branch_id = ? AND status = 'pending_review'
      `).get(branch.id) as { n: number };
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
      const row = db.prepare(`
        SELECT COUNT(*) AS n FROM bookings
        WHERE branch_id = ?
          AND status IN ('confirmed','seated')
          AND table_id IS NULL
          AND booking_date >= ?
      `).get(branch.id, todayBkk) as { n: number };
      if (row.n > 0) {
        items.push({
          kind: "confirmed_no_table",
          count: row.n,
          href: "/admin/reserva/bookings"
        });
      }
    } catch { /* ignore */ }

    // 3. Shift unlock requests — branch is on the linked daily_report row.
    try {
      const row = db.prepare(`
        SELECT COUNT(*) AS n
        FROM shift_unlock_requests sur
        JOIN daily_reports dr ON dr.id = sur.daily_report_id
        WHERE dr.branch_id = ? AND sur.status = 'pending'
      `).get(branch.id) as { n: number };
      if (row.n > 0) {
        items.push({
          kind: "shift_unlock_requests",
          count: row.n,
          href: "/admin/persona/shift-reports"
        });
      }
    } catch { /* table may not exist yet — ignore */ }

    // 4. Pending leave requests — chain-of-command aware (2026-05).
    //    Show only items where THIS user is the current_approver, so
    //    each manager sees their own queue (not everyone's). Super
    //    admin also sees fallback items (current_approver IS NULL —
    //    shouldn't happen post-migration but defensive).
    try {
      const row = db.prepare(`
        SELECT COUNT(*) AS n
        FROM leave_requests lr
        WHERE lr.status = 'pending'
          AND lr.current_approver_user_id = ?
          AND lr.user_id IN (
            SELECT user_id FROM user_branches WHERE branch_id = ?
          )
      `).get(user.id, branch.id) as { n: number };
      if (row.n > 0) {
        items.push({
          kind: "leave_requests",
          count: row.n,
          href: "/admin/persona/leave"
        });
      }
    } catch { /* ignore */ }

    if (items.length === 0) continue;  // skip clean branches
    const branchTotal = items.reduce((s, it) => s + it.count, 0);
    branches.push({
      branch_id: branch.id,
      branch_name: branch.name,
      branch_slug: branch.slug,
      total: branchTotal,
      items
    });
  }

  const total = branches.reduce((s, b) => s + b.total, 0);
  return NextResponse.json({
    user_name: user.display_name,
    user_prefix: user.title_prefix,
    total,
    branches
  } as OwlAdminPendingResponse);
}
