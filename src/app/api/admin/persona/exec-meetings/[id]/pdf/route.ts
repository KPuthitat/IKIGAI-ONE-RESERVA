import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getExecMeeting } from "@/lib/exec-meetings";
import { generateExecMeetingPdf } from "@/lib/exec-meeting-pdf";

export const dynamic = "force-dynamic";

// GET /api/admin/persona/exec-meetings/[id]/pdf — meeting summary report PDF
// (owner 2026-09-02): agenda, attendance + fee, AI summary/checklist/carryover,
// and each attendee's minutes per วาระ.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const id = Number(params.id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const d = getExecMeeting(id);
  if (!d) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const pdf = await generateExecMeetingPdf(d);
  return new NextResponse(pdf as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="exec-meeting-${id}.pdf"`
    }
  });
}
