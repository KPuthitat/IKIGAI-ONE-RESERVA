import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { notifyLeaveEvent } from "@/lib/approval-notify";
import { canActOnRequestTiered, type TierLevel } from "@/lib/approval-tiers";

const Body = z.object({
  decision: z.enum(["approved", "rejected", "revision_requested"]),
  note: z.string().max(500).optional()
});

// POST /api/admin/persona/leave/[id]/decide — admin approve/reject
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const db = getDb();
  const row = db.prepare(
    "SELECT user_id, status, branch_id, current_tier FROM leave_requests WHERE id = ?"
  ).get(id) as {
    user_id: number;
    status: string;
    branch_id: number | null;
    current_tier: number | null;
  } | undefined;

  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Branch guard (Phase 2): admin can only approve/reject requests
  // from branches they're assigned to. Legacy rows with NULL branch_id
  // (pre-migration) stay reachable as a one-time grace period.
  if (row.branch_id != null && !userHasBranch(user, row.branch_id)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }
  if (row.status !== "pending") {
    return NextResponse.json(
      { error: "already_decided", currentStatus: row.status },
      { status: 409 }
    );
  }

  // Tier-based authorisation (2026-05). On rows with a tier set, the
  // approving admin must be in that tier (or super_admin). Legacy rows
  // with NULL current_tier fall through to the old behaviour (any
  // admin with branch access can decide) so historical pending rows
  // don't get stuck.
  if (row.current_tier != null && row.branch_id != null) {
    const tier = row.current_tier as TierLevel;
    const eligible = canActOnRequestTiered(
      { id: user.id, role: user.role },
      row.branch_id,
      tier,
      row.user_id
    );
    if (!eligible) {
      return NextResponse.json(
        {
          error: "not_in_approval_tier",
          message: `คุณไม่ได้อยู่ในชั้นที่ ${tier} ของสายบังคับบัญชา ไม่สามารถอนุมัติคำขอนี้ได้`,
          tier
        },
        { status: 403 }
      );
    }
  }

  const nowIso = new Date().toISOString();

  // For tier-1 approves we don't terminate — we bump current_tier
  // to 2 and re-fire a "submitted"-style notification to the
  // executive cohort. Only tier-2 approves actually flip status to
  // 'approved'. Rejections at any tier terminate immediately.
  if (parsed.data.decision === "approved" && row.current_tier === 1) {
    // Advance to tier 2 — request stays 'pending', just at a higher tier.
    db.prepare(`
      UPDATE leave_requests
      SET current_tier = 2,
          last_escalated_at = ?
      WHERE id = ?
    `).run(nowIso, id);
    notifyLeaveEvent({
      requestId: id,
      event: "tier_advanced"
    }).catch((e) => console.warn("leave notify (tier_advanced) failed", e));
    return NextResponse.json({ ok: true, status: "pending", tier: 2 });
  }

  // Tier-2 approve OR any-tier reject OR revision_requested: terminal.
  db.prepare(`
    UPDATE leave_requests
    SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?
    WHERE id = ?
  `).run(parsed.data.decision, user.id, nowIso, parsed.data.note ?? null, id);

  if (parsed.data.decision === "approved" || parsed.data.decision === "rejected") {
    notifyLeaveEvent({
      requestId: id,
      event: parsed.data.decision,
      decidedTier: (row.current_tier as TierLevel | null) ?? undefined
    }).catch((e) => console.warn("leave notify (decision) failed", e));
  }

  return NextResponse.json({ ok: true, status: parsed.data.decision });
}
