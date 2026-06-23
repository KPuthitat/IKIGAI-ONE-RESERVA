import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { saveScores, updateAssessment, COMPETENCY_SCALE } from "@/lib/competency-db";

// Competency assessment writes. POST action save | finalize | reopen.
// Gated by ascenda.view (the ASCENDA layout already enforces it for pages).

const ScoreZ = z.object({
  dimension_id: z.number().int().positive(),
  self_score: z.number().min(0).max(COMPETENCY_SCALE).nullable().optional(),
  reviewer_score: z.number().min(0).max(COMPETENCY_SCALE).nullable().optional(),
  target_score: z.number().min(0).max(COMPETENCY_SCALE).nullable().optional(),
  note: z.string().max(300).nullable().optional()
});
const Body = z.object({
  assessment_id: z.number().int().positive(),
  action: z.enum(["save", "finalize", "reopen"]),
  scores: z.array(ScoreZ).optional(),
  track: z.string().max(40).nullable().optional(),
  note: z.string().max(1000).nullable().optional()
});

export async function POST(req: Request) {
  requirePermission("ascenda.view");
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  // Guard: the assessment must exist.
  const exists = getDb().prepare("SELECT id FROM competency_assessments WHERE id = ?").get(d.assessment_id);
  if (!exists) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (d.scores && d.scores.length) saveScores(d.assessment_id, d.scores);
  if (d.action === "save") updateAssessment(d.assessment_id, { track: d.track ?? undefined, note: d.note ?? undefined });
  else if (d.action === "finalize") updateAssessment(d.assessment_id, { status: "final", track: d.track ?? undefined, note: d.note ?? undefined });
  else if (d.action === "reopen") updateAssessment(d.assessment_id, { status: "draft" });

  return NextResponse.json({ ok: true });
}
