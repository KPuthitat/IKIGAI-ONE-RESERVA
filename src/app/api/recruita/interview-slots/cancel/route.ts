import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { cancelInterviewBooking } from "@/lib/recruita-interview-slots";

// POST /api/recruita/interview-slots/cancel  (public, candidate)
//   Body: { application_id, line_user_id?, mobile_phone? }
//
// Self-service interview CANCELLATION from the status page (owner
// 2026-06-11: "ยกเลิกได้เพื่อปล่อยคิวให้คนอื่น"). Frees the slot the
// applicant booked back to 'open' and clears the booking off the
// application. Ownership is proven the same way as booking: the LINE
// userId bound to the candidate, OR the mobile phone on file — at least
// one must match. No stage gate (they can release a slot regardless).

const Body = z.object({
  application_id: z.number().int().positive(),
  line_user_id: z.string().regex(/^U[0-9a-fA-F]{32}$/).optional(),
  mobile_phone: z.string().min(9).max(20).optional()
});

export async function POST(req: Request) {
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
    SELECT a.id, c.line_user_id, c.mobile_phone
    FROM recruita_applications a
    JOIN recruita_candidates c ON c.id = a.candidate_id
    WHERE a.id = ?
  `).get(application_id) as
    | { id: number; line_user_id: string | null; mobile_phone: string | null }
    | undefined;
  if (!app) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const norm = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
  const lineMatches = !!line_user_id && app.line_user_id === line_user_id;
  // ≥9-digit floor — norm() strips non-digits, so a junk phone (norm → "")
  // must not match a candidate whose phone is NULL/empty.
  const phoneMatches = norm(mobile_phone).length >= 9 && norm(app.mobile_phone) === norm(mobile_phone);
  if (!lineMatches && !phoneMatches) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const r = cancelInterviewBooking(application_id);
  return NextResponse.json({ ok: true, freed: r.freed });
}
