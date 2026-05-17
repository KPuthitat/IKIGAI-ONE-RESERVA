import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// POST /api/inventa/counts/[id]/submit — close the weekly count.
// Items already had current_qty updated as each line was saved, so
// submit just locks the session for history.

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  const r = db.prepare(`
    UPDATE inventa_counts
    SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'open'
  `).run(id);
  if (r.changes === 0) {
    return NextResponse.json({ error: "not_open" }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
