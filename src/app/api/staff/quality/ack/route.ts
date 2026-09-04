import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { acknowledgeVersion } from "@/lib/quality-docs";

// POST /api/staff/quality/ack — staff acknowledges an effective (approved) WI/WP
// version. Only approved versions the staff is eligible to read (doc branch NULL
// or a branch they belong to) can be acknowledged. Idempotent.
const Body = z.object({ version_id: z.number().int().positive() });

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const versionId = parsed.data.version_id;

  const db = getDb();
  const row = db.prepare(`
    SELECT v.status, d.branch_id
    FROM quality_document_versions v
    JOIN quality_documents d ON d.id = v.document_id
    WHERE v.id = ?
  `).get(versionId) as { status: string; branch_id: number | null } | undefined;
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (row.status !== "approved") {
    return NextResponse.json({ error: "not_effective" }, { status: 409 });
  }
  // Branch-scoped docs are readable only by staff belonging to that branch.
  if (row.branch_id != null) {
    const member = db.prepare(
      "SELECT 1 FROM user_branches WHERE user_id = ? AND branch_id = ? LIMIT 1"
    ).get(user.id, row.branch_id);
    if (!member) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  acknowledgeVersion(db, versionId, user.id);
  logPersonaAction(user.id, "quality.ack", versionId);
  return NextResponse.json({ ok: true });
}
