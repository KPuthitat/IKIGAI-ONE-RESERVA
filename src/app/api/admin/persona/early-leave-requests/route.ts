import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { verifyAdminPin } from "@/lib/admin-pin";
import { decideEarlyLeave } from "@/lib/early-leave";

// POST /api/admin/persona/early-leave-requests — admin approves/rejects a
// staffer's early-leave for a day (owner 2026-07-30). An approval exempts that
// day's food-credit SVC clawback, so it's a money-affecting decision → PIN-gated
// (same rule as granting OT). Upserts, so an admin can pre-approve before the
// staff files.

const Body = z.object({
  user_id: z.number().int().positive(),
  work_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  decision: z.enum(["approved", "rejected"]),
  pin: z.string().min(1)
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const branchId = user.activeBranchId ?? null;
  if (!branchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { user_id, work_date, decision, pin } = parsed.data;

  const pinRes = verifyAdminPin(user.id, pin);
  if (!pinRes.ok) {
    return NextResponse.json({ error: pinRes.reason }, { status: pinRes.reason === "no_pin" ? 400 : 403 });
  }

  // Target must be an employee in the admin's branch.
  const target = getDb().prepare(`
    SELECT u.id FROM users u
    INNER JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?
    WHERE u.id = ?
  `).get(branchId, user_id) as { id: number } | undefined;
  if (!target) return NextResponse.json({ error: "user_not_in_branch" }, { status: 404 });

  decideEarlyLeave(user_id, branchId, work_date, decision, user.id);
  logPersonaAction(user.id, `early_leave.${decision}`, user_id);
  return NextResponse.json({ ok: true });
}
