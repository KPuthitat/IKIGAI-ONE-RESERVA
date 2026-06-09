import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { deleteOpenSlot } from "@/lib/recruita-interview-slots";

// DELETE /api/recruita/interview-slots/[id]  (admin)
//   Remove a single OPEN slot. A booked slot can't be deleted here —
//   cancel/reschedule the interview first so the applicant isn't left
//   pointing at a slot that vanished.

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  requireAdmin();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const r = deleteOpenSlot(id);
  if (!r.ok) {
    return NextResponse.json(
      { ok: false, error: "not_deletable", message: "ลบไม่ได้ — ช่วงนี้ถูกจองแล้วหรือไม่มีอยู่" },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true });
}
