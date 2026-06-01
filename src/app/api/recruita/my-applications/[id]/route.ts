import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";

// DELETE /api/recruita/my-applications/[id]
//
// Candidate self-service deletion. A candidate who opened the status
// page via LIFF can delete their OWN application — but only while it's
// still at the 'applied' stage (i.e. before any admin has acted on
// it). This lets them scrap a mistaken submission and re-apply.
//
// Authorisation: the requesting LINE userId (proven by LIFF) must match
// the candidate.line_user_id on the application. We don't touch the
// candidate row or uploaded documents — only the single application,
// so a fresh submission simply reuses the deduped candidate.

const BodySchema = z.object({
  line_user_id: z.string().regex(/^U[0-9a-fA-F]{32}$/)
});

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: "bad_body" }, { status: 400 });
  }

  const db = getDb();
  const row = db.prepare(`
    SELECT a.id, a.stage, c.line_user_id
    FROM recruita_applications a
    JOIN recruita_candidates c ON c.id = a.candidate_id
    WHERE a.id = ?
  `).get(id) as { id: number; stage: string; line_user_id: string | null } | undefined;

  if (!row) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  // Ownership — the LINE account must own this application.
  if (!row.line_user_id || row.line_user_id !== body.line_user_id) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  // Only deletable before an admin has moved it out of 'applied'.
  if (row.stage !== "applied") {
    return NextResponse.json(
      { ok: false, error: "not_deletable", message: "ใบสมัครนี้อยู่ระหว่างการพิจารณาแล้ว จึงไม่สามารถลบได้" },
      { status: 409 }
    );
  }

  db.prepare("DELETE FROM recruita_applications WHERE id = ?").run(id);
  console.info(`[recruita] candidate self-deleted application #${id}`);
  return NextResponse.json({ ok: true });
}
