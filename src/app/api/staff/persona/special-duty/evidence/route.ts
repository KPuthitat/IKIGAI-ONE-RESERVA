import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { EvidenceError, submitEvidence } from "@/lib/special-duty-evidence";
import { EVIDENCE_TEXT } from "@/lib/special-duty-viewer";

// POST {day_id | day_ids, photos: dataUrl[], no_people: true} — the person doing the duty sends photos of the work area;
// day_ids sends one set of photos for several jobs done on the same day.
const Body = z.object({ day_id: z.number().int().positive().optional(), day_ids: z.array(z.number().int().positive()).max(10).optional(), photos: z.array(z.string().max(4_000_000)).max(10), no_people: z.boolean() });

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  if (p.data.day_id == null && !p.data.day_ids?.length) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  try {
    submitEvidence({ dayId: p.data.day_id, dayIds: p.data.day_ids, userId: user.id, photos: p.data.photos, noPeopleConfirmed: p.data.no_people });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof EvidenceError) return NextResponse.json({ ok: false, error: e.code, message: EVIDENCE_TEXT[e.code] ?? e.code }, { status: 422 });
    throw e;
  }
}
