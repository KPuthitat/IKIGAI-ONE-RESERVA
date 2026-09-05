import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { buildLineBreakdown } from "@/lib/payroll-breakdown";

// GET /api/admin/persona/payroll/periods/[id]/lines/[userId]/breakdown
//
// Per-day breakdown of a single staff's pay-period line — thin wrapper over
// buildLineBreakdown (shared with the payslip so the modal and the slip's
// per-day log are computed from ONE source; see src/lib/payroll-breakdown.ts).
//
// Auth: any signed-in admin. Branch scoping of the entries happens inside the
// builder (matches the pay engine).

export async function GET(
  _req: Request,
  { params }: { params: { id: string; userId: string } }
) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin" && user.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const periodId = Number(params.id);
  const userId = Number(params.userId);
  if (!Number.isInteger(periodId) || periodId <= 0) {
    return NextResponse.json({ error: "invalid_period_id" }, { status: 400 });
  }
  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ error: "invalid_user_id" }, { status: 400 });
  }

  const bd = buildLineBreakdown(getDb(), periodId, userId);
  if (!bd) return NextResponse.json({ error: "period_not_found" }, { status: 404 });

  return NextResponse.json({ ok: true, ...bd });
}
