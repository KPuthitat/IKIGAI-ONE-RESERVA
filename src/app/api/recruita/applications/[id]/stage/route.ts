import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { notifyStageChange } from "@/lib/recruita-notify";

// POST /api/recruita/applications/[id]/stage  { stage: ApplicationStage }
//
// Update the lifecycle stage on a single application. Phase 0d
// just persisted the stage; Phase 1e adds a fire-and-forget LINE
// push to the candidate when their stage advances, via the
// "IKIGAI Recruit" OA. Push is a no-op when the candidate has no
// linked line_user_id (web-form applicants) or the OA isn't
// configured yet — the API still returns ok so the admin UI
// updates regardless.

const Body = z.object({
  stage: z.enum([
    "applied", "screening", "interview", "offered",
    "accepted", "hired", "rejected", "withdrawn"
  ])
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  requireSuperAdmin();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const db = getDb();
  const row = db.prepare("SELECT id FROM recruita_applications WHERE id = ?").get(id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  db.prepare(`
    UPDATE recruita_applications
    SET stage = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(parsed.data.stage, id);

  // Fire-and-forget LINE push to the candidate. Wrapped in catch so
  // a LINE outage (or a temporary 429) never blocks the stage write.
  void notifyStageChange(id).catch((e) =>
    console.warn("[recruita-stage] notify failed", e)
  );

  return NextResponse.json({ ok: true });
}
