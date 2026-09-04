import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { addRevision } from "@/lib/quality-docs";

// POST /api/admin/persona/quality/documents/[id] — start a new revision (draft).

const Body = z.object({
  content: z.string().max(100_000).optional(),
  change_summary: z.string().max(500).optional(),
  effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = requirePermission("quality.manage");
  const documentId = Number(params.id);
  if (!Number.isInteger(documentId) || documentId <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const db = getDb();
  const doc = db.prepare("SELECT id FROM quality_documents WHERE id = ?").get(documentId);
  if (!doc) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const res = addRevision(db, documentId, {
    createdBy: user.id, content: parsed.data.content ?? null,
    changeSummary: parsed.data.change_summary ?? null, effectiveDate: parsed.data.effective_date ?? null
  });
  logPersonaAction(user.id, "quality.doc.revision", documentId);
  return NextResponse.json({ ok: true, ...res });
}
