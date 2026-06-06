import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { verifyAdminPin, hasAdminPin } from "@/lib/admin-pin";
import { decideShiftRequest } from "@/lib/shift-requests";
import {
  upsertAssignment, deleteAssignment, recordPublish,
  occupiedPositionIdsOnDate, userPositionOnDate
} from "@/lib/roster";

// POST /api/admin/persona/shift-request/[id]/approve-assign
//   body { position_id, shift_code_id, pin, note? }
//
// Owner 2026-06-06: approve a shift-change request AND write it into the
// roster in one PIN-confirmed step.
//   • extra_shift → assign the staff to position_id on work_date.
//   • swap        → also clear the staff's slot on off_date.
// Then mark the request approved (notifies the staff) + log + bump the
// roster publish timestamp so totals/staff-per-day refresh on view.

const Body = z.object({
  position_id: z.number().int().positive(),
  shift_code_id: z.number().int().positive(),
  pin: z.string().max(12),
  note: z.string().max(500).optional()
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = requireAdmin();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  // PIN gate (same flow as payroll/clinical destructive actions).
  if (hasAdminPin(user.id)) {
    const v = verifyAdminPin(user.id, parsed.data.pin);
    if (!v.ok) return NextResponse.json({ error: "bad_pin" }, { status: 403 });
  }

  const db = getDb();
  const reqRow = db.prepare(`
    SELECT id, user_id, branch_id, kind, work_date, off_date, status
    FROM shift_change_requests WHERE id = ?
  `).get(id) as {
    id: number; user_id: number; branch_id: number | null;
    kind: "extra_shift" | "swap"; work_date: string; off_date: string | null; status: string;
  } | undefined;
  if (!reqRow) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (reqRow.status !== "pending") return NextResponse.json({ error: "not_pending" }, { status: 409 });

  const branchId = reqRow.branch_id;
  const isSuper = user.role === "super_admin";
  if (!branchId || (!isSuper && branchId !== (user.activeBranchId ?? null))) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }

  // Validate position + shift code belong to this branch, and that the
  // chosen slot is still free on the work date (re-check server-side).
  const pos = db.prepare("SELECT id FROM roster_positions WHERE id = ? AND branch_id = ? AND active = 1")
    .get(parsed.data.position_id, branchId);
  const sc = db.prepare("SELECT id FROM shift_codes WHERE id = ? AND branch_id = ? AND active = 1")
    .get(parsed.data.shift_code_id, branchId);
  if (!pos || !sc) return NextResponse.json({ error: "invalid_slot" }, { status: 400 });
  if (occupiedPositionIdsOnDate(branchId, reqRow.work_date).includes(parsed.data.position_id)) {
    return NextResponse.json({ error: "slot_taken" }, { status: 409 });
  }
  // Requester must belong to the branch.
  const inBranch = db.prepare("SELECT 1 FROM user_branches WHERE user_id = ? AND branch_id = ?")
    .get(reqRow.user_id, branchId);
  if (!inBranch) return NextResponse.json({ error: "user_not_in_branch" }, { status: 403 });

  // Write the roster (transaction): clear the swap's off-date slot first,
  // then assign the work-date slot.
  const tx = db.transaction(() => {
    if (reqRow.kind === "swap" && reqRow.off_date) {
      const offPos = userPositionOnDate(branchId, reqRow.user_id, reqRow.off_date);
      if (offPos != null) {
        deleteAssignment({ branchId, date: reqRow.off_date, positionId: offPos });
      }
    }
    upsertAssignment({
      branchId, date: reqRow.work_date,
      positionId: parsed.data.position_id,
      userId: reqRow.user_id,
      shiftCodeId: parsed.data.shift_code_id,
      actingUserId: user.id
    });
  });
  tx();

  // Mark approved (notifies the requester) + audit + bump publish stamps.
  decideShiftRequest(user.id, id, "approved", parsed.data.note?.trim() || null);
  logPersonaAction(user.id, "shift_request.approve_assign", id);
  recordPublish(branchId, reqRow.work_date.slice(0, 7), "edit", user.id, null);
  if (reqRow.kind === "swap" && reqRow.off_date && reqRow.off_date.slice(0, 7) !== reqRow.work_date.slice(0, 7)) {
    recordPublish(branchId, reqRow.off_date.slice(0, 7), "edit", user.id, null);
  }

  return NextResponse.json({ ok: true });
}
