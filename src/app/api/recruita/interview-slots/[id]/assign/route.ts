import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { bookInterviewSlot } from "@/lib/recruita-interview-slots";
import { notifyInterviewScheduled, notifyExecGroupInterviewBooked } from "@/lib/recruita-notify";

// POST /api/recruita/interview-slots/[id]/assign  (admin)
//   Body: { application_id }
//
// Admin books an open slot ON BEHALF OF an applicant (owner 2026-06-11:
// "ลงเวลานัดสัมภาษณ์แทนผู้สมัครได้") — the staff-side counterpart of the
// applicant's self-service /book. No candidate identity needed (admin
// authority). bookInterviewSlot frees any slot the application already
// holds, so this also re-schedules. Candidate + exec group are notified,
// fire-and-forget, just like self-booking.

const Body = z.object({ application_id: z.number().int().positive() });

export async function POST(req: Request, { params }: { params: { id: string } }) {
  requireAdmin();
  const slotId = Number(params.id);
  if (!Number.isInteger(slotId) || slotId <= 0) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "bad_body" }, { status: 400 });
  }
  const { application_id } = parsed.data;

  const db = getDb();
  const app = db.prepare(
    "SELECT id, stage FROM recruita_applications WHERE id = ?"
  ).get(application_id) as { id: number; stage: string } | undefined;
  if (!app) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (app.stage !== "interview") {
    return NextResponse.json(
      { ok: false, error: "stage_not_interview", message: "ใบสมัครนี้ยังไม่อยู่ในขั้นนัดสัมภาษณ์" },
      { status: 409 }
    );
  }

  const r = bookInterviewSlot({ slotId, applicationId: application_id });
  if (!r.ok) {
    const message =
      r.error === "slot_taken" ? "ช่วงเวลานี้ถูกจองแล้ว กรุณาเลือกช่วงอื่น" :
      r.error === "not_found" ? "ไม่พบช่วงเวลานี้แล้ว" : "ลงนัดไม่สำเร็จ";
    return NextResponse.json({ ok: false, error: r.error, message }, { status: 409 });
  }

  void notifyInterviewScheduled(application_id).catch((e) =>
    console.warn("[recruita] admin-assign candidate notify failed", e));
  void notifyExecGroupInterviewBooked(application_id).catch((e) =>
    console.warn("[recruita] admin-assign exec notify failed", e));

  return NextResponse.json({ ok: true, interview_at: r.interviewAt, location: r.location });
}
