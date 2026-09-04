import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { createDocument } from "@/lib/quality-docs";

// POST /api/admin/persona/quality/documents — create a WI/WP document (rev 1 draft).

const Body = z.object({
  doc_type: z.enum(["WI", "WP"]),
  title: z.string().trim().min(1).max(200),
  department: z.string().trim().max(120).optional(),
  owner_user_id: z.number().int().positive().nullable().optional(),
  branch_id: z.number().int().positive().nullable().optional(),
  content: z.string().max(100_000).optional(),
  effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  change_summary: z.string().max(500).optional()
});

export async function POST(req: Request) {
  const user = requirePermission("quality.manage");
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  const db = getDb();
  const res = createDocument(db, {
    docType: d.doc_type, title: d.title, department: d.department ?? null,
    ownerUserId: d.owner_user_id ?? null, branchId: d.branch_id ?? null, createdBy: user.id,
    content: d.content ?? null, effectiveDate: d.effective_date ?? null, changeSummary: d.change_summary ?? null
  });
  logPersonaAction(user.id, "quality.doc.create", res.documentId);
  return NextResponse.json({ ok: true, ...res });
}
