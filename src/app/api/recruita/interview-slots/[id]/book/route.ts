import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { bookInterviewSlot } from "@/lib/recruita-interview-slots";
import { notifyInterviewScheduled, notifyExecGroupInterviewBooked } from "@/lib/recruita-notify";

// POST /api/recruita/interview-slots/[id]/book  (public, candidate)
//   Body: { application_id, line_user_id?, mobile_phone? }
//
// Self-service interview booking from the status page. Authorisation
// mirrors the rest of the candidate self-service surface: the requester
// must prove they own the application by EITHER the LINE userId bound to
// the candidate (LIFF path) OR the mobile phone on file (phone-search
// path). At least one must match.
//
// Booking is only allowed while the application is at the 'interview'
// stage (that's when the team has invited them to pick a time). The
// slot claim is first-come-first-served; a race loses with "slot_taken".

const Body = z.object({
  application_id: z.number().int().positive(),
  line_user_id: z.string().regex(/^U[0-9a-fA-F]{32}$/).optional(),
  mobile_phone: z.string().min(9).max(20).optional()
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const slotId = Number(params.id);
  if (!Number.isInteger(slotId) || slotId <= 0) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "bad_body" }, { status: 400 });
  }
  const { application_id, line_user_id, mobile_phone } = parsed.data;
  if (!line_user_id && !mobile_phone) {
    return NextResponse.json({ ok: false, error: "no_identity" }, { status: 400 });
  }

  const db = getDb();
  const app = db.prepare(`
    SELECT a.id, a.stage, c.line_user_id, c.mobile_phone
    FROM recruita_applications a
    JOIN recruita_candidates c ON c.id = a.candidate_id
    WHERE a.id = ?
  `).get(application_id) as
    | { id: number; stage: string; line_user_id: string | null; mobile_phone: string | null }
    | undefined;
  if (!app) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  // Ownership — at least one identity proof must match the candidate.
  const lineMatches = !!line_user_id && app.line_user_id === line_user_id;
  const norm = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
  const phoneMatches = !!mobile_phone && norm(app.mobile_phone) === norm(mobile_phone);
  if (!lineMatches && !phoneMatches) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // Only bookable while invited to interview.
  if (app.stage !== "interview") {
    return NextResponse.json(
      { ok: false, error: "stage_not_interview", message: "ใบสมัครนี้ยังไม่อยู่ในขั้นนัดสัมภาษณ์" },
      { status: 409 }
    );
  }

  const r = bookInterviewSlot({ slotId, applicationId: application_id });
  if (!r.ok) {
    const message =
      r.error === "slot_taken" ? "ช่วงเวลานี้มีผู้เลือกแล้ว กรุณาเลือกเวลาอื่น" :
      r.error === "not_found" ? "ไม่พบช่วงเวลานี้แล้ว" : "จองไม่สำเร็จ";
    return NextResponse.json({ ok: false, error: r.error, message }, { status: 409 });
  }

  // Notify both sides — candidate confirmation + exec group. Both are
  // fire-and-forget; a LINE hiccup must not fail the booking write.
  void notifyInterviewScheduled(application_id).catch((e) =>
    console.warn("[recruita] booking candidate notify failed", e));
  void notifyExecGroupInterviewBooked(application_id).catch((e) =>
    console.warn("[recruita] booking exec notify failed", e));

  return NextResponse.json({ ok: true, interview_at: r.interviewAt, location: r.location });
}
