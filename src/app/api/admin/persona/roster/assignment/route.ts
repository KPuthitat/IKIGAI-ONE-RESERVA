import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import {
  upsertAssignment,
  deleteAssignment,
  recordPublish
} from "@/lib/roster";

// Roster assignment endpoints.
//   POST   = upsert one (date, position) → (user, shift_code) cell
//   DELETE = clear the cell
//
// Both also log to persona_activity_log + bump a "roster.edit"
// publish-log row so the staff calendar's "ตารางแก้ไขล่าสุด" banner
// updates in real time (the actual LINE broadcast is a separate
// publish endpoint to avoid spamming on every cell tweak).

const PostBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "invalid_date"),
  position_id: z.number().int().positive(),
  user_id: z.number().int().positive(),
  shift_code_id: z.number().int().positive()
});

const DeleteBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  position_id: z.number().int().positive()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  if (!userHasBranch(user, user.activeBranchId)) return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });

  const parsed = PostBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  // Belt-and-braces: verify the position + shift_code + user actually
  // belong to this admin's active branch. Without this, an admin who
  // swaps branches could (in theory) write into a sibling branch by
  // editing the id in DevTools.
  const db = getDb();
  const pos = db.prepare("SELECT branch_id FROM roster_positions WHERE id = ? AND active = 1").get(d.position_id) as { branch_id: number } | undefined;
  if (!pos || pos.branch_id !== user.activeBranchId) return NextResponse.json({ error: "position_forbidden" }, { status: 403 });
  const sc = db.prepare("SELECT branch_id FROM shift_codes WHERE id = ? AND active = 1").get(d.shift_code_id) as { branch_id: number } | undefined;
  if (!sc || sc.branch_id !== user.activeBranchId) return NextResponse.json({ error: "shift_code_forbidden" }, { status: 403 });
  // user must be assigned to the branch (user_branches)
  const ub = db.prepare("SELECT 1 AS ok FROM user_branches WHERE user_id = ? AND branch_id = ?").get(d.user_id, user.activeBranchId) as { ok: 1 } | undefined;
  if (!ub) return NextResponse.json({ error: "user_not_in_branch" }, { status: 400 });

  const r = upsertAssignment({
    branchId: user.activeBranchId,
    date: d.date,
    positionId: d.position_id,
    userId: d.user_id,
    shiftCodeId: d.shift_code_id,
    actingUserId: user.id
  });
  const ym = d.date.slice(0, 7);
  // Bump the edit-log row so the staff calendar timestamp updates.
  // We don't fire LINE here — that's done via the dedicated /publish
  // endpoint to avoid notification spam during a long editing session.
  recordPublish(user.activeBranchId, ym, "edit", user.id, null);
  logPersonaAction(
    user.id,
    r.created ? "roster.assignment.create" : "roster.assignment.update",
    r.id
  );
  return NextResponse.json({ ok: true, id: r.id, created: r.created });
}

export async function DELETE(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });

  const parsed = DeleteBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;
  const removed = deleteAssignment({
    branchId: user.activeBranchId,
    date: d.date,
    positionId: d.position_id
  });
  const ym = d.date.slice(0, 7);
  recordPublish(user.activeBranchId, ym, "edit", user.id, null);
  logPersonaAction(user.id, "roster.assignment.delete", d.position_id);
  return NextResponse.json({ ok: true, removed });
}
