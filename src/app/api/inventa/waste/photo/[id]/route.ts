import { NextResponse } from "next/server";
import fs from "fs";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getWastePhotoPath } from "@/lib/inventa-waste-photo";

// GET /api/inventa/waste/photo/[id]
//
// Streams the evidence photo attached to a waste entry. Scoped to the caller's
// active branch — the same filter listWaste uses — so a staffer can't enumerate
// ids to pull another branch's photos.
export function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const branchId = user.activeBranchId ?? null;
  const row = getDb().prepare(
    "SELECT photo_path FROM inventa_waste WHERE id = ? AND (branch_id IS ? OR branch_id = ?)"
  ).get(id, branchId, branchId) as { photo_path: string | null } | undefined;
  if (!row?.photo_path) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const full = getWastePhotoPath(row.photo_path);
  if (!full) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const buf = fs.readFileSync(full);
  const ext = (row.photo_path.split(".").pop() || "").toLowerCase();
  const contentType = ext === "webp" ? "image/webp" : ext === "png" ? "image/png" : "image/jpeg";
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `inline; filename="${row.photo_path}"`,
      "Cache-Control": "private, max-age=300"
    }
  });
}
