import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanViewPayroll, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { setSvcForfeitExemption } from "@/lib/service-charge";

// POST /api/admin/persona/service-charge/forfeit-exemption
//
// Executive override (owner 2026-08-20): SVC forfeiture (late >20% or a
// forfeit-flagged resignation) is automatic, but an exec can WAIVE it for one
// person for one month so they still receive their SVC ("ยกเว้นให้"). Toggling
// this flips `forfeited` back to false in every SVC view + the payout, keyed per
// (user, month). Gated to payroll-access admins — the same group that manages the
// SVC payout and the shared-pool toggle.

const Body = z.object({
  user_id: z.number().int().positive(),
  year_month: z.string().regex(/^\d{4}-\d{2}$/, "invalid_month"),
  exempted: z.boolean(),
  note: z.string().trim().max(500).optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!user.activeBranchId || !userHasBranch(user, user.activeBranchId)) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 }
    );
  }

  const db = getDb();

  // Scope: the target must be a member of a branch in the SAME company as the
  // acting admin's active branch — a payroll admin can't waive a forfeiture for
  // someone outside their company (the client-supplied user_id is untrusted).
  const inCompany = db.prepare(`
    SELECT 1 FROM user_branches ub
    JOIN branches b  ON b.id = ub.branch_id
    JOIN branches ab ON ab.company_id = b.company_id
    WHERE ub.user_id = ? AND ab.id = ? LIMIT 1
  `).get(parsed.data.user_id, user.activeBranchId);
  if (!inCompany) {
    return NextResponse.json({ error: "user_out_of_scope" }, { status: 403 });
  }

  // Integrity: once the month's SVC payout is finalized / paid / posted (ACCOUNTA)
  // for any branch this person belongs to, the distribution is locked — changing
  // the exemption now would diverge the live view from what was actually paid.
  const locked = db.prepare(`
    SELECT 1 FROM svc_payout_batches
    WHERE year_month = ? AND status IN ('finalized', 'paid', 'posted')
      AND branch_id IN (SELECT branch_id FROM user_branches WHERE user_id = ?)
    LIMIT 1
  `).get(parsed.data.year_month, parsed.data.user_id);
  if (locked) {
    return NextResponse.json({ error: "payout_locked" }, { status: 409 });
  }

  setSvcForfeitExemption({
    userId: parsed.data.user_id,
    yearMonth: parsed.data.year_month,
    exempted: parsed.data.exempted,
    byUserId: user.id,
    note: parsed.data.note ?? null
  });
  logPersonaAction(
    user.id,
    parsed.data.exempted ? "svc.forfeitExemption.grant" : "svc.forfeitExemption.revoke",
    parsed.data.user_id
  );
  return NextResponse.json({ ok: true, exempted: parsed.data.exempted });
}
