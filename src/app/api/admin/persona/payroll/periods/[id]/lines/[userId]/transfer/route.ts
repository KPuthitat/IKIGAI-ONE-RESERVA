import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// POST /api/admin/persona/payroll/periods/[id]/lines/[userId]/transfer
//
// Mark a payroll line "ทำรายการแล้ว" (pay actually transferred) or clear it (owner 2026-10-19). Pay-all and
// post-all stay locked until everyone is ticked. A tracking tick only — touches no money — so no PIN.
// Allowed once the period is finalized, and until it is posted to the books.

const Body = z.object({ done: z.boolean() });

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
  const period = db.prepare("SELECT status, posted_at FROM payroll_periods WHERE id = ?")
    .get(periodId) as { status: string; posted_at: string | null } | undefined;
  if (!period) return NextResponse.json({ error: "period_not_found" }, { status: 404 });
  if (period.status !== "finalized" && period.status !== "paid") return NextResponse.json({ error: "must_be_finalized", message: "ต้องปิดยอดก่อนจึงติ๊กทำรายการได้" }, { status: 400 });
  if (period.posted_at) return NextResponse.json({ error: "already_posted", message: "ลงบัญชีแล้ว ติ๊กไม่ได้" }, { status: 400 });

  const info = parsed.data.done
    ? db.prepare(`UPDATE payroll_lines SET transferred_at = CURRENT_TIMESTAMP, transferred_by = ? WHERE period_id = ? AND user_id = ?`).run(user.id, periodId, userId)
    : db.prepare(`UPDATE payroll_lines SET transferred_at = NULL, transferred_by = NULL WHERE period_id = ? AND user_id = ?`).run(periodId, userId);
  if (info.changes === 0) return NextResponse.json({ error: "line_not_found" }, { status: 404 });

  logPersonaAction(user.id, "payroll.line.transfer", periodId);
  return NextResponse.json({ ok: true });
}
