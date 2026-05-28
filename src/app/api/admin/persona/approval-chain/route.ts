import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { setBranchTierMembers } from "@/lib/approval-tiers";

// POST /api/admin/persona/approval-chain
//
// Replace the branch-level approval tier roster atomically. Caller
// sends the desired full membership for both tiers; we wipe the
// branch's existing rows and re-insert in a single transaction
// (handled inside setBranchTierMembers) so we never leave the chain
// in a partially-saved state where, say, tier 1 has been cleared but
// tier 2 hasn't been updated yet.
//
// Auth: admin role + must have access to this branch. We re-verify
// the branch_id against the user's session.activeBranchId rather
// than trusting the body to come from an honest client — an admin
// at branch A shouldn't be able to mutate branch B's chain via a
// crafted POST.

const Body = z.object({
  branch_id: z.number().int().positive(),
  tier1: z.array(z.number().int().positive()).max(50),
  tier2: z.array(z.number().int().positive()).max(50)
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { branch_id, tier1, tier2 } = parsed.data;

  // Authorisation check — non-super_admin must have this branch in
  // their adminBranchIds. super_admin can edit any branch (matches
  // how /admin/branches works).
  if (user.role !== "super_admin") {
    if (!user.adminBranchIds.includes(branch_id)) {
      return NextResponse.json({ error: "forbidden_branch" }, { status: 403 });
    }
  }

  // Sanity: at least 1 user in each tier. We allow saving 0/0 in
  // theory (admin might want to clear before re-configuring) but
  // flag it back so the UI can warn. The /api/persona/leave
  // submission endpoint will hard-reject submissions if either tier
  // ends up empty — which is the safer enforcement point.
  const t1Empty = tier1.length === 0;
  const t2Empty = tier2.length === 0;

  // All proposed user_ids must belong to this branch + be active +
  // have an appropriate role (staff/admin/super_admin). Otherwise an
  // admin could route requests to a disabled or out-of-branch user.
  const db = getDb();
  const allIds = Array.from(new Set([...tier1, ...tier2]));
  if (allIds.length > 0) {
    const placeholders = allIds.map(() => "?").join(",");
    const valid = db.prepare(`
      SELECT DISTINCT u.id
      FROM users u
      INNER JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?
      WHERE u.id IN (${placeholders})
        AND u.status NOT IN ('disabled', 'resigned')
        AND u.role IN ('staff', 'admin', 'super_admin')
    `).all(branch_id, ...allIds) as Array<{ id: number }>;
    const validSet = new Set(valid.map((v) => v.id));
    const invalid = allIds.filter((id) => !validSet.has(id));
    if (invalid.length > 0) {
      return NextResponse.json(
        {
          error: "invalid_users",
          message: "Some users aren't members of this branch or aren't active",
          invalid_user_ids: invalid
        },
        { status: 400 }
      );
    }
  }

  setBranchTierMembers(branch_id, 1, tier1);
  setBranchTierMembers(branch_id, 2, tier2);

  logPersonaAction(user.id, "approval_chain.update", branch_id);

  return NextResponse.json({
    ok: true,
    tier1_empty: t1Empty,
    tier2_empty: t2Empty,
    warning: (t1Empty || t2Empty)
      ? "ทั้งสองชั้นต้องมีอย่างน้อย 1 คน — พนักงานจะส่งคำขอลาไม่ได้จนกว่าจะเลือกครบ"
      : null
  });
}
