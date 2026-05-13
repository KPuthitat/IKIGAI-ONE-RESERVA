import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { upsertDailyServiceCharge } from "@/lib/service-charge";

// POST /api/admin/persona/service-charge/daily
//
// Admin upsert of one branch-day SVC entry. Same endpoint handles
// both create (first time entered for that date) and correct
// (admin fixes a closing-shift miskeyed value). Audit:
//   • daily_service_charge.entered_by_user_id / updated_by_user_id
//     captures who-touched-what at the row level
//   • persona_activity_log gets a 'svc.daily.create'/'svc.daily.update'
//     entry per write — same audit pattern as other PERSONA mutations
//
// Branch is always the admin's activeBranchId (no branch_id in body)
// so cross-branch tampering is impossible by construction.

const Body = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "invalid_date"),
  // SVC amount is allowed to be 0 (no SVC collected that day, e.g.
  // closed for renovation). Cap at 999_999 baht/day — far above any
  // realistic single-branch figure, but blocks accidental ฿9999999
  // typos before they pollute the monthly view.
  amount_baht: z.number().min(0).max(999_999),
  // Optional link to the shift_close daily_report row when the entry
  // came in via the staff form. Admin direct-entry leaves this null.
  daily_report_id: z.number().int().positive().nullable().optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!user.activeBranchId) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }
  if (!userHasBranch(user, user.activeBranchId)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 }
    );
  }

  const result = upsertDailyServiceCharge({
    branchId: user.activeBranchId,
    date: parsed.data.date,
    amountBaht: parsed.data.amount_baht,
    userId: user.id,
    dailyReportId: parsed.data.daily_report_id ?? null
  });
  logPersonaAction(
    user.id,
    result.created ? "svc.daily.create" : "svc.daily.update",
    result.id
  );
  return NextResponse.json({ ok: true, id: result.id, created: result.created });
}
