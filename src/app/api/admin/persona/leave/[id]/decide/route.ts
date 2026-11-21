import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { applyLeaveDecision, checkLeaveDecision } from "@/lib/leave-decide";
import { verifyAdminPin } from "@/lib/admin-pin";

const Body = z.object({
  decision: z.enum(["approved", "rejected", "revision_requested"]),
  note: z.string().max(500).optional(),
  /** PIN required for approved + rejected decisions (high-trust ops). */
  pin: z.string().optional()
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

  const actor = { id: user.id, role: user.role, branchIds: user.branches.map((b) => b.id) };
  const check = checkLeaveDecision(id, actor);
  if (!check.ok) {
    if (check.error === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (check.error === "branch_forbidden") return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
    if (check.error === "already_decided") return NextResponse.json({ error: "already_decided", currentStatus: check.currentStatus }, { status: 409 });
    return NextResponse.json(
      {
        error: "not_in_approval_tier",
        message: `คุณไม่ได้อยู่ในชั้นที่ ${check.tier} ของสายบังคับบัญชา ไม่สามารถอนุมัติคำขอนี้ได้`,
        tier: check.tier
      },
      { status: 403 }
    );
  }

  // PIN gate — required for approve + reject (terminal/irreversible decisions).
  // revision_requested is reversible (staff can resubmit) so no PIN needed.
  if (parsed.data.decision === "approved" || parsed.data.decision === "rejected") {
    const pinStr = (parsed.data.pin ?? "").trim();
    if (!pinStr) {
      return NextResponse.json(
        { error: "pin_required", message: "ต้องใส่ PIN ก่อนอนุมัติหรือปฏิเสธ" },
        { status: 400 }
      );
    }
    const pinCheck = verifyAdminPin(user.id, pinStr);
    if (!pinCheck.ok) {
      return NextResponse.json(
        { error: pinCheck.reason, message: pinCheck.reason === "no_pin" ? "ยังไม่ได้ตั้ง PIN" : "PIN ไม่ถูกต้อง" },
        { status: 401 }
      );
    }
  }

  const applied = applyLeaveDecision(id, check.row, actor, parsed.data.decision, parsed.data.note ?? null);
  return NextResponse.json({ ok: true, ...applied });
}
