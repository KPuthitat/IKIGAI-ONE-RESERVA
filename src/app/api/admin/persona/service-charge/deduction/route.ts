import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanViewPayroll, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { addSvcDeduction, deleteSvcDeduction } from "@/lib/service-charge";

// POST/DELETE /api/admin/persona/service-charge/deduction
//
// Ad-hoc SVC deductions (owner 2026-08-20) — e.g. ค่าเครื่องดื่มที่ไม่ใช่คูปอง.
// Payroll-access admins add reason + amount per (user, month); it's taken from the
// person's SVC (after the food clawback, before WHT). Same guards as the
// forfeiture exemption: same-company only, and blocked once the month's payout is
// finalized/paid/posted for a branch the person belongs to.

const PostBody = z.object({
  user_id: z.number().int().positive(),
  year_month: z.string().regex(/^\d{4}-\d{2}$/, "invalid_month"),
  amount: z.number().positive().max(999_999),
  reason: z.string().trim().max(200).optional()
});
const DeleteBody = z.object({ id: z.number().int().positive() });

function guard(userId: number, activeBranchId: number, targetUserId: number, yearMonth: string): { error: string; status: number } | null {
  const db = getDb();
  const inCompany = db.prepare(`
    SELECT 1 FROM user_branches ub
    JOIN branches b  ON b.id = ub.branch_id
    JOIN branches ab ON ab.company_id = b.company_id
    WHERE ub.user_id = ? AND ab.id = ? LIMIT 1
  `).get(targetUserId, activeBranchId);
  if (!inCompany) return { error: "user_out_of_scope", status: 403 };
  const locked = db.prepare(`
    SELECT 1 FROM svc_payout_batches
    WHERE year_month = ? AND status IN ('finalized', 'paid', 'posted')
      AND branch_id IN (SELECT branch_id FROM user_branches WHERE user_id = ?)
    LIMIT 1
  `).get(yearMonth, targetUserId);
  if (locked) return { error: "payout_locked", status: 409 };
  return null;
}

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!user.activeBranchId || !userHasBranch(user, user.activeBranchId)) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }
  const parsed = PostBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });

  const g = guard(user.id, user.activeBranchId, parsed.data.user_id, parsed.data.year_month);
  if (g) return NextResponse.json({ error: g.error }, { status: g.status });

  const id = addSvcDeduction({
    userId: parsed.data.user_id, yearMonth: parsed.data.year_month,
    amount: Math.round(parsed.data.amount * 100) / 100,
    reason: parsed.data.reason?.trim() || null, byUserId: user.id
  });
  logPersonaAction(user.id, "svc.deduction.add", parsed.data.user_id);
  return NextResponse.json({ ok: true, id });
}

export async function DELETE(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!user.activeBranchId || !userHasBranch(user, user.activeBranchId)) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }
  const parsed = DeleteBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const row = getDb().prepare("SELECT user_id, year_month FROM svc_deductions WHERE id = ?")
    .get(parsed.data.id) as { user_id: number; year_month: string } | undefined;
  if (!row) return NextResponse.json({ ok: true }); // already gone
  const g = guard(user.id, user.activeBranchId, row.user_id, row.year_month);
  if (g) return NextResponse.json({ error: g.error }, { status: g.status });

  deleteSvcDeduction(parsed.data.id);
  logPersonaAction(user.id, "svc.deduction.delete", row.user_id);
  return NextResponse.json({ ok: true });
}
