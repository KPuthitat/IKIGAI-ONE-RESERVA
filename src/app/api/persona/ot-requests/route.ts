import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// POST /api/persona/ot-requests — a staff member records that they had
// pre-approved OT for a day (entered at clock-out when น้องฮูก asks).
// Creates a PENDING request; a supervisor/admin must approve before it
// counts toward pay. One request per (user, day) — re-submitting updates
// it back to pending.
//
// No per-request LINE push (owner 2026-06-08): pending OT now surfaces in
// the DAILY pending-requests digest sent to the HR group (see
// pending-digest.ts) — bundled to save LINE quota instead of one push per
// request.

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const Body = z.object({
  work_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  requested_until: z.string().regex(HHMM)
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { work_date, requested_until } = parsed.data;
  const branchId = user.activeBranchId ?? null;
  const db = getDb();

  db.prepare(`
    INSERT INTO ot_requests (user_id, branch_id, work_date, requested_until, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
    ON CONFLICT (user_id, work_date) DO UPDATE SET
      requested_until = excluded.requested_until,
      branch_id = excluded.branch_id,
      status = 'pending',
      decided_by = NULL,
      decided_at = NULL
  `).run(user.id, branchId, work_date, requested_until, new Date().toISOString());

  // No immediate LINE push — pending OT is summarised in the daily
  // pending-requests digest to the HR group (owner 2026-06-08).
  return NextResponse.json({ ok: true });
}
