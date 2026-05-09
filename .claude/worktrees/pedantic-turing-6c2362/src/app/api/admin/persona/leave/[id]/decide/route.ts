import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

const Body = z.object({
  decision: z.enum(["approved", "rejected", "revision_requested"]),
  note: z.string().max(500).optional()
});

// POST /api/admin/persona/leave/[id]/decide — admin approve/reject
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const db = getDb();
  const row = db.prepare(
    "SELECT status FROM leave_requests WHERE id = ?"
  ).get(id) as { status: string } | undefined;

  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (row.status !== "pending") {
    return NextResponse.json(
      { error: "already_decided", currentStatus: row.status },
      { status: 409 }
    );
  }

  const nowIso = new Date().toISOString();
  db.prepare(`
    UPDATE leave_requests
    SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?
    WHERE id = ?
  `).run(parsed.data.decision, user.id, nowIso, parsed.data.note ?? null, id);

  return NextResponse.json({ ok: true, status: parsed.data.decision });
}
