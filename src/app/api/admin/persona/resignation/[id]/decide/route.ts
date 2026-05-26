import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { canActOnRequestTiered, type TierLevel } from "@/lib/approval-tiers";

const Body = z.object({
  decision: z.enum(["approved", "rejected", "revision_requested"]),
  note: z.string().max(500).optional(),
  // forfeit_svc — when admin approves a resignation that breaks
  // company policy ("ลาออกผิดกติกา"), tick this to forfeit the
  // resigning staff's whole-month SVC accrual to the company.
  // Default false (staff keeps their SVC). Only honoured when
  // decision === "approved" — set it on a reject and we ignore.
  forfeit_svc: z.boolean().optional()
});

// POST /api/admin/persona/resignation/[id]/decide
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const db = getDb();
  // Resignation rows track the same branch + tier columns as
  // leave_requests (added 2026-05). We branch-resolve via the
  // requester's active branch since resignation_requests doesn't
  // store branch_id directly yet (planned migration). For tier auth
  // we read current_tier directly.
  const row = db.prepare(`
    SELECT r.status, r.user_id, r.current_tier,
           (SELECT ub.branch_id
              FROM user_branches ub
              WHERE ub.user_id = r.user_id
              ORDER BY ub.is_primary DESC, ub.branch_id ASC
              LIMIT 1) AS branch_id
    FROM resignation_requests r
    WHERE r.id = ?
  `).get(id) as {
    status: string;
    user_id: number;
    current_tier: number | null;
    branch_id: number | null;
  } | undefined;

  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (row.status !== "pending") {
    return NextResponse.json({ error: "already_decided", currentStatus: row.status }, { status: 409 });
  }

  // Tier-based authorisation — same shape as the leave decide route.
  // Legacy rows with NULL current_tier fall through (no gate) so old
  // pending requests don't get stuck.
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

  // Tier-1 approves advance instead of finalize; tier-2 approves and
  // any rejections terminate immediately. Matches the leave flow.
  if (parsed.data.decision === "approved" && row.current_tier === 1) {
    db.prepare(`
      UPDATE resignation_requests
      SET current_tier = 2,
          last_escalated_at = ?
      WHERE id = ?
    `).run(nowIso, id);
    return NextResponse.json({ ok: true, status: "pending", tier: 2 });
  }

  // Only persist forfeit_svc on approvals — irrelevant + misleading
  // for a reject or revision-request decision.
  const forfeit = parsed.data.decision === "approved" && parsed.data.forfeit_svc === true ? 1 : 0;
  db.prepare(`
    UPDATE resignation_requests
    SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, forfeit_svc = ?
    WHERE id = ?
  `).run(parsed.data.decision, user.id, nowIso, parsed.data.note ?? null, forfeit, id);

  return NextResponse.json({ ok: true, status: parsed.data.decision, forfeit_svc: !!forfeit });
}
