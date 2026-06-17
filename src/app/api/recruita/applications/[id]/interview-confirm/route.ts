import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { setInterviewConfirmed } from "@/lib/recruita-interview-slots";

// POST /api/recruita/applications/[id]/interview-confirm  (admin)
//   Body: { confirmed: boolean }
//
// Lock (or unlock) a candidate's interview appointment. Once confirmed the
// candidate can no longer reschedule/cancel from the status page (owner
// 2026-06-17: "ไม่ให้เปลี่ยนวัน หากแอดมินคอนเฟิร์มวันนัดไปแล้ว"). Admins can
// still move it via the slot board (assign bypasses the lock).

const Body = z.object({ confirmed: z.boolean() });

export async function POST(req: Request, { params }: { params: { id: string } }) {
  requireAdmin();
  const applicationId = Number(params.id);
  if (!Number.isInteger(applicationId) || applicationId <= 0) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "bad_body" }, { status: 400 });
  }
  const r = setInterviewConfirmed(applicationId, parsed.data.confirmed);
  if (!r.ok) {
    return NextResponse.json(
      { ok: false, error: "no_booking", message: "ใบสมัครนี้ยังไม่มีการนัดสัมภาษณ์" },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true, confirmed: parsed.data.confirmed });
}
