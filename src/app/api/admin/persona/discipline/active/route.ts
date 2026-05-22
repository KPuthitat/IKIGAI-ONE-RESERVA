import { NextResponse } from "next/server";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getSuggestedSeverity, listActiveWarnings } from "@/lib/discipline";

// GET /api/admin/persona/discipline/active?user_id=N
//
// Returns the user's active (non-expired) warnings + the recommended
// next severity for a new offence. Admin form calls this when the
// user-picker changes, then renders a "พนักงานคนนี้มีคำเตือน X ฉบับ
// อยู่ — แนะนำใช้ <Y>" panel above the severity dropdown.
//
// Admin-only, branch-scoped (must share at least one branch with the
// target user — same scoping as the issue POST).

export async function GET(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!user.activeBranchId) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }

  const url = new URL(req.url);
  const userIdRaw = url.searchParams.get("user_id");
  const userId = Number(userIdRaw);
  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ error: "invalid_user_id" }, { status: 400 });
  }

  // Branch guard — admin can only inspect users in their active branch.
  const db = getDb();
  const inBranch = db.prepare(
    "SELECT 1 AS ok FROM user_branches WHERE user_id = ? AND branch_id = ?"
  ).get(userId, user.activeBranchId) as { ok: 1 } | undefined;
  if (!inBranch) {
    return NextResponse.json({ error: "user_not_in_branch" }, { status: 403 });
  }

  const active = listActiveWarnings(userId);
  const suggestion = getSuggestedSeverity(userId);

  return NextResponse.json({
    active: active.map((w) => ({
      id: w.id,
      ref_no: w.ref_no,
      severity: w.severity,
      title: w.title,
      issued_at: w.issued_at,
      validity_months: w.validity_months,
      acknowledged_at: w.acknowledged_at
    })),
    suggested: suggestion.suggested,
    highest_active: suggestion.highestActive,
    active_count: suggestion.activeCount
  });
}
