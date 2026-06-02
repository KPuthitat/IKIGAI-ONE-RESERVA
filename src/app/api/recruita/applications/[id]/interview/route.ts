import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { notifyInterviewScheduled } from "@/lib/recruita-notify";

// POST /api/recruita/applications/[id]/interview
//   Body: { interview_at: "YYYY-MM-DDTHH:MM", location?, note? }
//
// Schedule (or reschedule) an interview. interview_at is a NAIVE
// Bangkok-local datetime from the admin's datetime-local picker — we
// store it verbatim (same convention as bookings, no timezone math).
// On success we fire-and-forget a LINE push to the candidate with the
// date/time/location.

const Body = z.object({
  interview_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  location: z.string().max(300).optional().default(""),
  note: z.string().max(500).optional().default("")
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  requireSuperAdmin();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", message: "วัน/เวลาสัมภาษณ์ไม่ถูกต้อง" },
      { status: 400 }
    );
  }
  const db = getDb();
  const row = db.prepare("SELECT id FROM recruita_applications WHERE id = ?").get(id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  db.prepare(`
    UPDATE recruita_applications
    SET interview_at = ?, interview_location = ?, interview_note = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    parsed.data.interview_at,
    parsed.data.location || null,
    parsed.data.note || null,
    id
  );

  // Fire-and-forget candidate push (no-op if not LINE-linked / OA off).
  void notifyInterviewScheduled(id).catch((e) =>
    console.warn("[recruita] interview notify failed", e)
  );

  return NextResponse.json({ ok: true });
}
