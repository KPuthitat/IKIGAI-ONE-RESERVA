import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, type Booking, type Branch } from "@/lib/db";
import { notifyCustomer } from "@/lib/line";

// POST /api/staff/redemption/claim
//
// Staff clicks "เคลมไอติม" after handing the free ice cream over to
// the first-time customer. Works for both bookings AND walk-in
// visits — the body carries the table name + id.
//
// Idempotent: re-posting on an already-claimed row returns ok with
// `already_claimed: true` instead of 409, so a double-tap on the
// button doesn't trip an error toast.
//
// Auth: any logged-in staff at the same branch as the row. We
// deliberately allow staff (not just admin) so the front-of-house
// can claim without bouncing back to a manager — the staff_credits
// row records WHO claimed for ASCENDA scoring later.

const Body = z.object({
  kind: z.enum(["booking", "walk_in"]),
  id: z.number().int().positive()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { kind, id } = parsed.data;

  const db = getDb();
  const now = new Date().toISOString();

  if (kind === "booking") {
    const row = db.prepare(`
      SELECT b.*, br.id AS _branch_id_check
      FROM bookings b
      JOIN branches br ON br.id = b.branch_id
      WHERE b.id = ?
    `).get(id) as Booking | undefined;
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

    // Branch check — staff can only claim for their own branch (unless
    // super_admin who manages everything).
    if (user.role !== "super_admin" && row.branch_id !== user.activeBranchId) {
      return NextResponse.json({ error: "wrong_branch" }, { status: 403 });
    }

    if (row.redemption_status === "claimed") {
      return NextResponse.json({
        ok: true, already_claimed: true, claimed_at: row.redeemed_at
      });
    }
    if (row.redemption_status !== "eligible") {
      return NextResponse.json({
        error: "not_eligible", status: row.redemption_status
      }, { status: 409 });
    }

    db.prepare(`
      UPDATE bookings
      SET redemption_status = 'claimed',
          redeemed_at = ?,
          redeemed_by_user_id = ?,
          updated_at = ?
      WHERE id = ?
    `).run(now, user.id, now, id);

    // ASCENDA credit — the staff member captured a first-time
    // customer's redemption. Idempotent only at the DB level (no
    // unique index yet) — relying on the redemption_status guard
    // above to prevent double-credit on the same row.
    db.prepare(`
      INSERT INTO staff_credits
        (user_id, branch_id, kind, points, ref_table, ref_id, created_at)
      VALUES (?, ?, 'first_time_redemption', 1, 'bookings', ?, ?)
    `).run(user.id, row.branch_id, id, now);

    // Refresh the customer's Flex card so the "claimed" banner replaces
    // the "eligible" banner — best effort.
    const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
      .get(row.branch_id) as Branch | undefined;
    if (branch && row.line_user_id) {
      const updated = db.prepare("SELECT * FROM bookings WHERE id = ?")
        .get(id) as Booking;
      notifyCustomer(branch, updated, "created").catch((e) =>
        console.error("notify after claim failed", e)
      );
    }
    return NextResponse.json({ ok: true, claimed_at: now });
  }

  // kind === 'walk_in'
  const visit = db.prepare(`
    SELECT id, branch_id, redemption_status, redeemed_at
    FROM walk_in_visits WHERE id = ?
  `).get(id) as {
    id: number; branch_id: number;
    redemption_status: string | null; redeemed_at: string | null;
  } | undefined;
  if (!visit) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (user.role !== "super_admin" && visit.branch_id !== user.activeBranchId) {
    return NextResponse.json({ error: "wrong_branch" }, { status: 403 });
  }

  if (visit.redemption_status === "claimed") {
    return NextResponse.json({
      ok: true, already_claimed: true, claimed_at: visit.redeemed_at
    });
  }
  if (visit.redemption_status !== "eligible") {
    return NextResponse.json({
      error: "not_eligible", status: visit.redemption_status
    }, { status: 409 });
  }

  db.prepare(`
    UPDATE walk_in_visits
    SET redemption_status = 'claimed',
        redeemed_at = ?,
        redeemed_by_user_id = ?
    WHERE id = ?
  `).run(now, user.id, id);

  db.prepare(`
    INSERT INTO staff_credits
      (user_id, branch_id, kind, points, ref_table, ref_id, created_at)
    VALUES (?, ?, 'first_time_redemption', 1, 'walk_in_visits', ?, ?)
  `).run(user.id, visit.branch_id, id, now);

  return NextResponse.json({ ok: true, claimed_at: now });
}
