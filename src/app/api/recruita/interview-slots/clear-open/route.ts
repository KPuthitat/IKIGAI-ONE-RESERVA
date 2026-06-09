import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { clearOpenSlots } from "@/lib/recruita-interview-slots";

// POST /api/recruita/interview-slots/clear-open  (admin)
//   Remove every OPEN (un-booked) slot. Booked slots are left intact so
//   pending interviews aren't lost. Use to reset the pool between rounds.

export async function POST() {
  requireAdmin();
  const { removed } = clearOpenSlots();
  return NextResponse.json({ ok: true, removed });
}
