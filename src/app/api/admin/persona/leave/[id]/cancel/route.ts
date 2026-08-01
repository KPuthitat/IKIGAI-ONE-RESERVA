import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { verifyAdminPin } from "@/lib/admin-pin";

// POST /api/admin/persona/leave/[id]/cancel
//
// Admin revokes a leave request — including an ALREADY-APPROVED one (owner
// 2026-08-01: พนักงานขอลาไว้ แล้วเปลี่ยนใจจะมาทำงาน — เดิมยกเลิกลาที่อนุมัติแล้ว
// ไม่ได้เลย เลยลงกะทับวันลาก็ไม่ได้). Cancelling frees the day: the roster
// picker no longer greys the staffer out, and payroll stops counting the leave
// on the next recompute. PIN-gated + audited. Draft/period state is untouched —
// recompute the affected pay period after cancelling.
//
// Works on pending / revision_requested / approved. Rejected/cancelled rows are
// already terminal.

const Body = z.object({
  pin: z.string().optional(),
  note: z.string().max(500).optional()
});

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
    "SELECT user_id, status, branch_id FROM leave_requests WHERE id = ?"
  ).get(id) as { user_id: number; status: string; branch_id: number | null } | undefined;
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Branch guard — same as decide: admin acts only on their branch's requests
  // (legacy NULL-branch rows stay reachable).
  if (row.branch_id != null && !userHasBranch(user, row.branch_id)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }
  if (!["pending", "revision_requested", "approved"].includes(row.status)) {
    return NextResponse.json(
      { error: "cannot_cancel", currentStatus: row.status },
      { status: 409 }
    );
  }

  // PIN gate — cancelling an approved leave changes attendance/pay, so re-prove.
  const pinStr = (parsed.data.pin ?? "").trim();
  if (!pinStr) {
    return NextResponse.json({ error: "pin_required", message: "ต้องใส่ PIN ก่อนยกเลิกการลา" }, { status: 400 });
  }
  const pinCheck = verifyAdminPin(user.id, pinStr);
  if (!pinCheck.ok) {
    return NextResponse.json(
      { error: pinCheck.reason, message: pinCheck.reason === "no_pin" ? "ยังไม่ได้ตั้ง PIN" : "PIN ไม่ถูกต้อง" },
      { status: 401 }
    );
  }

  db.prepare(`
    UPDATE leave_requests
    SET status = 'cancelled', decided_by = ?, decided_at = ?, decision_note = ?
    WHERE id = ?
  `).run(user.id, new Date().toISOString(), parsed.data.note?.trim() || "ยกเลิกโดยแอดมิน", id);
  logPersonaAction(user.id, "leave.cancel", id);

  return NextResponse.json({ ok: true, status: "cancelled" });
}
