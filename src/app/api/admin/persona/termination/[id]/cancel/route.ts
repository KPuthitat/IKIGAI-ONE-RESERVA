import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { cancelTermination, getTermination } from "@/lib/termination";

// POST /api/admin/persona/termination/[id]/cancel — call off a still
// 'scheduled' termination. The staff stays employed; the cron sweep will
// no longer pick the record up.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const row = getTermination(id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (row.status !== "scheduled") {
    return NextResponse.json({ error: "not_scheduled", currentStatus: row.status }, { status: 409 });
  }
  const ok = cancelTermination(user.id, id);
  if (!ok) return NextResponse.json({ error: "not_scheduled" }, { status: 409 });
  logPersonaAction(user.id, "termination.cancel", id);
  return NextResponse.json({ ok: true });
}
