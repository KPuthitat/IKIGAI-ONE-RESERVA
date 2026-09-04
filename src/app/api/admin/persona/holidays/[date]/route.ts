import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// DELETE /api/admin/persona/holidays/[date] — admin remove holiday
export async function DELETE(_req: Request, { params }: { params: { date: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.date)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }

  const db = getDb();
  const result = db.transaction(() => {
    db.prepare("DELETE FROM holiday_branch_scope WHERE date = ?").run(params.date);
    return db.prepare("DELETE FROM public_holidays WHERE date = ?").run(params.date);
  })();
  if (result.changes === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
