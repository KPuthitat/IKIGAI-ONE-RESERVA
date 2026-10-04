import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { getWarning, voidWarning } from "@/lib/discipline";

// POST /api/admin/persona/discipline/[id]/void — an admin voids a warning (owner
// 2026-10-04: e.g. the app was down so the person could not clock out). The row
// stays on record with who/why, but no longer counts toward the escalation ladder
// and the staff no longer sees it.

const Body = z.object({ reason: z.string().trim().min(3).max(500) });

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  if (!userHasBranch(user, user.activeBranchId)) return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "reason_required" }, { status: 400 });

  const w = getWarning(id);
  if (!w || w.branch_id !== user.activeBranchId) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Nobody voids their own record — it has to be someone else's call.
  if (w.user_id === user.id) return NextResponse.json({ error: "cannot_void_own" }, { status: 403 });
  if (!voidWarning(id, user.id, parsed.data.reason)) return NextResponse.json({ error: "already_voided" }, { status: 409 });
  logPersonaAction(user.id, "discipline.void", id);
  return NextResponse.json({ ok: true });
}
