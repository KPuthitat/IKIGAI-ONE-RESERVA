import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// DELETE /api/persona/resignation/[id] — staff cancel own pending resignation
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const row = db.prepare(
    "SELECT user_id, status FROM resignation_requests WHERE id = ?"
  ).get(id) as { user_id: number; status: string } | undefined;

  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (row.user_id !== user.id) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (row.status !== "pending") return NextResponse.json({ error: "already_decided" }, { status: 409 });

  db.prepare("UPDATE resignation_requests SET status = 'cancelled' WHERE id = ?").run(id);
  return NextResponse.json({ ok: true });
}
