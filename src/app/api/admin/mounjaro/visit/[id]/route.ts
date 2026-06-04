import { NextResponse } from "next/server";
import { getSessionUser, isClinicalUnlocked } from "@/lib/auth";
import { deleteVisit, isMounjaroForbidden, type MjActor } from "@/lib/mounjaro-db";

// DELETE /api/admin/mounjaro/visit/[id] — remove one visit row from the
// doctor's own patient. Doctor + unlock gated; gateway re-scopes + audits.
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.clinical_role !== "doctor") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!isClinicalUnlocked(user)) return NextResponse.json({ error: "locked" }, { status: 403 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  try {
    deleteVisit(user as MjActor, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isMounjaroForbidden(e)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    return NextResponse.json({ error: "failed" }, { status: 400 });
  }
}
