import fs from "fs";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { photoForViewer } from "@/lib/special-duty-evidence";

// GET — a duty evidence photo, only for its owner or a manager of its branch.
export function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const manageBranchIds = user.role === "super_admin" ? user.branches.map((b) => b.id) : user.adminBranchIds;
  const hit = photoForViewer(id, { userId: user.id, manageBranchIds });
  if (!hit) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const type = hit.ext === "webp" ? "image/webp" : hit.ext === "png" ? "image/png" : "image/jpeg";
  return new NextResponse(new Uint8Array(fs.readFileSync(hit.path)), { status: 200, headers: { "Content-Type": type, "Cache-Control": "private, max-age=300" } });
}
