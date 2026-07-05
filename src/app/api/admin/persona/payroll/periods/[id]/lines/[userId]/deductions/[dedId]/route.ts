import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { verifyAdminPin } from "@/lib/admin-pin";
import { deleteLineDeduction, listLineDeductions } from "@/lib/payroll-deductions";

// DELETE one itemised deduction (PIN-gated; period must be draft).

const Body = z.object({ admin_pin: z.string().optional() });

export async function DELETE(req: Request, { params }: { params: { id: string; userId: string; dedId: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const periodId = Number(params.id);
  const userId = Number(params.userId);
  const dedId = Number(params.dedId);
  if (![periodId, userId, dedId].every(Number.isInteger)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  const adminPin = parsed.success ? parsed.data.admin_pin : undefined;
  if (!adminPin) return NextResponse.json({ error: "pin_required" }, { status: 400 });
  const pin = verifyAdminPin(user.id, adminPin);
  if (!pin.ok) return NextResponse.json({ error: pin.reason }, { status: pin.reason === "no_pin" ? 400 : 403 });

  const db = getDb();
  const period = db.prepare("SELECT status FROM payroll_periods WHERE id = ?").get(periodId) as { status: string } | undefined;
  if (!period) return NextResponse.json({ error: "period_not_found" }, { status: 404 });
  if (period.status !== "draft") return NextResponse.json({ error: "must_be_draft" }, { status: 400 });

  // Ensure the deduction belongs to this line before deleting.
  const owns = db.prepare("SELECT 1 FROM payroll_line_deductions WHERE id = ? AND period_id = ? AND user_id = ?")
    .get(dedId, periodId, userId);
  if (!owns) return NextResponse.json({ error: "not_found" }, { status: 404 });

  deleteLineDeduction(dedId);
  logPersonaAction(user.id, "payroll.deduction.delete", periodId);
  return NextResponse.json({ ok: true, deductions: listLineDeductions(periodId, userId) });
}
