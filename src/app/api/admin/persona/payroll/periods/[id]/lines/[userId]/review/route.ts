import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// POST /api/admin/persona/payroll/periods/[id]/lines/[userId]/review
//
// Mark a payroll line "ตรวจแล้ว" (reviewed) or clear it (owner 2026-08-03).
// A review sign-off only — touches no money — so no PIN, mirroring the
// recompute route. Draft period only (a reviewed line is auto-cleared the
// moment its numbers change, and after finalize the line can't change anyway).

const Body = z.object({ reviewed: z.boolean() });

export async function POST(
  req: Request,
  { params }: { params: { id: string; userId: string } }
) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const periodId = Number(params.id);
  const userId = Number(params.userId);
  if (!Number.isInteger(periodId) || !Number.isInteger(userId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const db = getDb();
  const period = db.prepare("SELECT status FROM payroll_periods WHERE id = ?")
    .get(periodId) as { status: string } | undefined;
  if (!period) return NextResponse.json({ error: "period_not_found" }, { status: 404 });
  if (period.status !== "draft") return NextResponse.json({ error: "must_be_draft" }, { status: 400 });

  const info = parsed.data.reviewed
    ? db.prepare(
        `UPDATE payroll_lines SET reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?
         WHERE period_id = ? AND user_id = ?`
      ).run(user.id, periodId, userId)
    : db.prepare(
        `UPDATE payroll_lines SET reviewed_at = NULL, reviewed_by = NULL
         WHERE period_id = ? AND user_id = ?`
      ).run(periodId, userId);
  if (info.changes === 0) return NextResponse.json({ error: "line_not_found" }, { status: 404 });

  logPersonaAction(user.id, "payroll.line.review", periodId);
  return NextResponse.json({ ok: true });
}
