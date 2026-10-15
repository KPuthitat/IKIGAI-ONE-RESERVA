import fs from "fs";
import { NextResponse } from "next/server";
import { getSessionUser, isAdminCapable } from "@/lib/auth";
import { imageForViewer } from "@/lib/policy-notices";

// GET — a picture attached to a policy notice: admins, or an employee the letter was sent to.
export function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const hit = imageForViewer(id, { userId: user.id, isAdmin: isAdminCapable(user) });
  if (!hit) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return new NextResponse(new Uint8Array(fs.readFileSync(hit.path)), { status: 200, headers: { "Content-Type": hit.mime, "Cache-Control": "private, max-age=3600" } });
}
