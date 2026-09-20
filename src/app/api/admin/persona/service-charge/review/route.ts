import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanViewPayroll, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { setSvcLineReview } from "@/lib/service-charge";

// POST /api/admin/persona/service-charge/review
//
// Per-person "ตรวจแล้ว" sign-off on the service-charge table (owner 2026-09-20):
// a reviewer ticks a row once they've verified that month's calculation. Touches
// NO money — a checklist marker only, so no PIN (mirrors the payroll line review).
// Same-company scope as the deduction/exemption routes.

const Body = z.object({
  user_id: z.number().int().positive(),
  year_month: z.string().regex(/^\d{4}-\d{2}$/, "invalid_month"),
  reviewed: z.boolean()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!user.activeBranchId || !userHasBranch(user, user.activeBranchId)) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const { user_id, year_month, reviewed } = parsed.data;

  // Only sign off on someone in the same company as the reviewer's active branch.
  const inCompany = getDb().prepare(`
    SELECT 1 FROM user_branches ub
    JOIN branches b  ON b.id = ub.branch_id
    JOIN branches ab ON ab.company_id = b.company_id
    WHERE ub.user_id = ? AND ab.id = ? LIMIT 1
  `).get(user_id, user.activeBranchId);
  if (!inCompany) return NextResponse.json({ error: "user_out_of_scope" }, { status: 403 });

  setSvcLineReview(year_month, user_id, reviewed, user.id);
  logPersonaAction(user.id, reviewed ? "svc.line.review" : "svc.line.unreview", user_id);
  return NextResponse.json({ ok: true, reviewed });
}
