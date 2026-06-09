import { NextResponse } from "next/server";
import { listBookableSlots } from "@/lib/recruita-interview-slots";

// GET /api/recruita/interview-slots/available  (public)
//
// Future interview slots for the candidate-facing status page. Returns
// BOTH open and booked slots (booked rendered as "ไม่ว่าง") so an
// applicant sees the whole window and which times are already taken.
// No candidate identity is exposed.

export const dynamic = "force-dynamic";

export async function GET() {
  const slots = listBookableSlots();
  return NextResponse.json({ ok: true, slots });
}
