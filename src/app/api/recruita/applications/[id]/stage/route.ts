import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";

// POST /api/recruita/applications/[id]/stage  { stage: ApplicationStage }
//
// Update the lifecycle stage on a single application. Phase 0d
// just persists the new stage + stamps updated_at; Phase 1 will
// layer notifications + an audit timeline on top.

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
  return NextResponse.json({ ok: true });
}
