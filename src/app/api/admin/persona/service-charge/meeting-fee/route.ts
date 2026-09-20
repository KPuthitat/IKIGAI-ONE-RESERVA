import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanViewPayroll, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { setManualMeetingFee } from "@/lib/service-charge";

// POST /api/admin/persona/service-charge/meeting-fee
//
// Manual lump-sum meeting fee (เบี้ยประชุมเหมาจ่าย, owner 2026-09-20): until
// meeting-time is tracked, the approver types a per-person GROSS amount for a
// month; it rides that month's SVC payout (payslip / bank CSV / accounta) like a
// computed meeting fee, WHT applied. Amount 0 clears it. Same guards as the SVC
// deduction route: payroll access, same-company scope, blocked once the month's
// payout is finalized/paid/posted for a branch the person belongs to.

const Body = z.object({
  user_id: z.number().int().positive(),
  year_month: z.string().regex(/^\d{4}-\d{2}$/, "invalid_month"),
  amount: z.number().min(0).max(9_999_999),
  note: z.string().trim().max(200).optional()
});

function guard(activeBranchId: number, targetUserId: number, yearMonth: string): { error: string; status: number } | null {
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
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const { user_id, year_month, amount, note } = parsed.data;

  const g = guard(user.activeBranchId, user_id, year_month);
  if (g) return NextResponse.json({ error: g.error }, { status: g.status });

  setManualMeetingFee({ userId: user_id, yearMonth: year_month, amount, note, byUserId: user.id });
  logPersonaAction(user.id, amount > 0 ? "svc.meeting_fee.set" : "svc.meeting_fee.clear", user_id);
  return NextResponse.json({ ok: true, amount });
}
