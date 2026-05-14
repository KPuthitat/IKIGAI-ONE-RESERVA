import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { startImpersonation, IMPERSONATOR_COOKIE } from "@/lib/impersonation";

// POST /api/admin/impersonate/[targetId] — "log in as" the target
// user for debugging. Super_admin can impersonate anyone; admin can
// impersonate staff in their own branch only. Banner shows on every
// page while active; /api/admin/impersonate/end restores.

export async function POST(_req: Request, { params }: { params: { targetId: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const targetId = Number(params.targetId);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  if (targetId === user.id) {
    return NextResponse.json({ error: "cannot_impersonate_self" }, { status: 400 });
  }
  const db = getDb();
  const target = db.prepare("SELECT id, role FROM users WHERE id = ?")
    .get(targetId) as { id: number; role: string } | undefined;
  if (!target) return NextResponse.json({ error: "target_not_found" }, { status: 404 });

  // Admin (non-super) can only impersonate staff and only within
  // their own branch. Super_admin has no such restriction.
  if (user.role === "admin") {
    if (target.role !== "staff") {
      return NextResponse.json({ error: "admin_can_only_impersonate_staff" }, { status: 403 });
    }
    const sameBranch = db.prepare(`
      SELECT 1 AS ok FROM user_branches ub
      WHERE ub.user_id = ?
        AND ub.branch_id IN (SELECT branch_id FROM user_branches WHERE user_id = ?)
      LIMIT 1
    `).get(targetId, user.id) as { ok: 1 } | undefined;
    if (!sameBranch) {
      return NextResponse.json({ error: "target_not_in_your_branch" }, { status: 403 });
    }
  }

  // Find the current session cookie so we can swap its user_id.
  const sessionId = cookies().get("reserva_session")?.value;
  if (!sessionId) return NextResponse.json({ error: "no_session" }, { status: 401 });

  const logId = startImpersonation({
    sessionId,
    impersonatorId: user.id,
    targetUserId: targetId,
    reason: null,
    ip: null,
    userAgent: null
  });
  logPersonaAction(user.id, "impersonation.start", logId);

  // Set the marker cookie so the banner renders + we know how to
  // restore on stop. Same scope as the main session cookie.
  cookies().set(IMPERSONATOR_COOKIE, String(logId), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 8 * 3600  // capped at 8h — long enough for any sane debug session
  });

  return NextResponse.json({ ok: true, log_id: logId });
}
