import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { parseLabelLayout, serializeLabelLayout } from "@/lib/label-layout";

// PATCH /api/inventa/label-layout — save (or reset) the active branch's
// drag-designed label layout (owner 2026-06-09).
//   body: { layout: LabelLayout }  → save
//   body: { reset: true }          → clear (revert to default)
export async function PATCH(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!user.activeBranchId) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  const db = getDb();

  if (body && body.reset === true) {
    db.prepare("UPDATE branches SET inventa_label_layout = NULL WHERE id = ?")
      .run(user.activeBranchId);
    return NextResponse.json({ ok: true, reset: true });
  }

  const layout = parseLabelLayout(JSON.stringify(body?.layout ?? null));
  if (!layout) {
    return NextResponse.json({ error: "invalid_layout" }, { status: 400 });
  }
  db.prepare("UPDATE branches SET inventa_label_layout = ? WHERE id = ?")
    .run(serializeLabelLayout(layout), user.activeBranchId);
  return NextResponse.json({ ok: true });
}
