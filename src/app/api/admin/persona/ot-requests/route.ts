import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { verifyAdminPin } from "@/lib/admin-pin";

// POST /api/admin/persona/ot-requests
//
// Admin grants OT directly to a staff member (owner 2026-06-14) — for the
// case where they worked past their shift but didn't file an OT request
// themselves. Creates (or upserts) an ALREADY-APPROVED ot_requests row, so
// it counts toward pay immediately. Works for both PT and FT now that OT is
// approval-gated for everyone.
//
// Because this directly changes a pay-affecting value, it requires the
// admin's PIN — same rule as editing an existing request's time.
// The pay engine credits OT = min(actual clock-out, requested_until) −
// scheduled end (flat rate per the OT settings), so the granted time only
// pays out up to what the staff actually worked.

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const Body = z.object({
  user_id: z.number().int().positive(),
  work_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  requested_until: z.string().regex(HHMM),
  pin: z.string().min(1)
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const branchId = user.activeBranchId ?? null;
  if (!branchId) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { user_id, work_date, requested_until, pin } = parsed.data;

  // Adding OT is a pay change → require the admin's PIN.
  const pinRes = verifyAdminPin(user.id, pin);
  if (!pinRes.ok) {
    return NextResponse.json({ error: pinRes.reason }, { status: pinRes.reason === "no_pin" ? 400 : 403 });
  }

  const db = getDb();
  // Target must be an active payroll employee in the admin's branch.
  const target = db.prepare(`
    SELECT u.id, u.employment_type
    FROM users u
    INNER JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?
    WHERE u.id = ? AND u.status NOT IN ('disabled', 'resigned')
  `).get(branchId, user_id) as { id: number; employment_type: string | null } | undefined;
  if (!target) {
    return NextResponse.json({ error: "user_not_in_branch" }, { status: 404 });
  }
  if (target.employment_type !== "pt" && target.employment_type !== "ft") {
    return NextResponse.json({ error: "not_eligible_for_ot" }, { status: 400 });
  }

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO ot_requests
      (user_id, branch_id, work_date, requested_until, status, decided_by, decided_at, created_at)
    VALUES (?, ?, ?, ?, 'approved', ?, ?, ?)
    ON CONFLICT (user_id, work_date) DO UPDATE SET
      requested_until = excluded.requested_until,
      branch_id = excluded.branch_id,
      status = 'approved',
      decided_by = excluded.decided_by,
      decided_at = excluded.decided_at
  `).run(user_id, branchId, work_date, requested_until, user.id, now, now);

  logPersonaAction(user.id, "ot.admin_add", user_id);
  return NextResponse.json({ ok: true });
}

const DeleteBody = z.object({
  user_id: z.number().int().positive(),
  work_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  pin: z.string().min(1)
});

// DELETE /api/admin/persona/ot-requests — remove a day's OT for a staff
// member (owner 2026-06-14, the "ลบออก" action). PIN-gated (pay change).
export async function DELETE(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const branchId = user.activeBranchId ?? null;
  if (!branchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });

  const parsed = DeleteBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { user_id, work_date, pin } = parsed.data;
  const pinRes = verifyAdminPin(user.id, pin);
  if (!pinRes.ok) {
    return NextResponse.json({ error: pinRes.reason }, { status: pinRes.reason === "no_pin" ? 400 : 403 });
  }

  const db = getDb();
  const r = db.prepare("DELETE FROM ot_requests WHERE user_id = ? AND work_date = ?")
    .run(user_id, work_date);
  if (r.changes > 0) logPersonaAction(user.id, "ot.admin_delete", user_id);
  return NextResponse.json({ ok: true, deleted: r.changes });
}
