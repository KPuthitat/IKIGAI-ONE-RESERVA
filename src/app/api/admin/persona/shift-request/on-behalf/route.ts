import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { verifyAdminPin, hasAdminPin } from "@/lib/admin-pin";
import { recordExtraShiftOnBehalf } from "@/lib/shift-requests";

// POST /api/admin/persona/shift-request/on-behalf
//   body { user_id, work_date, position_id, shift_code_id, pin, note? }
//
// Owner 2026-10-04: an admin records an extra-shift request ON BEHALF of an employee
// (typically a day worked on a day off that was never requested in the system, or a
// request the person could not file). It is created already APPROVED, the shift is
// written to the roster (unless the person already has a shift that day), and any
// DRAFT payroll line covering the date is recomputed — so a monthly employee gets the
// rest-day pay without filing anything. PIN-confirmed and audited like approve-assign.

const Body = z.object({
  user_id: z.number().int().positive(),
  work_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  position_id: z.number().int().positive(),
  shift_code_id: z.number().int().positive(),
  pin: z.string().max(12),
  note: z.string().trim().min(3).max(500)   // why it is being recorded for them — kept on the request
});

export async function POST(req: Request) {
  const user = requireAdmin();
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) return NextResponse.json({ error: "no_branch" }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const d = parsed.data;

  if (hasAdminPin(user.id)) {
    const v = verifyAdminPin(user.id, d.pin);
    if (!v.ok) return NextResponse.json({ error: "bad_pin" }, { status: 403 });
  }

  const r = recordExtraShiftOnBehalf({
    branchId, adminId: user.id, userId: d.user_id, workDate: d.work_date,
    positionId: d.position_id, shiftCodeId: d.shift_code_id, note: d.note
  });
  if (!r.ok) {
    return NextResponse.json({ error: r.error }, { status: r.error === "user_not_in_branch" ? 403 : r.error === "invalid_slot" ? 400 : 409 });
  }
  logPersonaAction(user.id, "shift_request.on_behalf", r.id);
  return NextResponse.json({ ok: true, id: r.id, ref_no: r.refNo, recomputedPeriods: r.recomputedPeriods });
}
