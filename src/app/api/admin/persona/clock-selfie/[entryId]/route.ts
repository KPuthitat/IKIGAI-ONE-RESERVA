import { NextResponse } from "next/server";
import fs from "fs";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getClockSelfiePath } from "@/lib/clock-selfie";

// GET /api/admin/persona/clock-selfie/[entryId]
//
// Streams the selfie captured at a given clock punch, for admin spot-check /
// dispute review. Auth: admin or super_admin (face images are sensitive — not
// exposed to peers). Mirrors the resignation-attachment route.
export async function GET(_req: Request, { params }: { params: { entryId: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const entryId = Number(params.entryId);
  if (!Number.isInteger(entryId) || entryId <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const row = getDb().prepare(
    "SELECT selfie_path FROM time_entries WHERE id = ?"
  ).get(entryId) as { selfie_path: string | null } | undefined;
  if (!row?.selfie_path) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const full = getClockSelfiePath(row.selfie_path);
  if (!full) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const buf = fs.readFileSync(full);
  const ext = (row.selfie_path.split(".").pop() || "").toLowerCase();
  const contentType = ext === "webp" ? "image/webp" : "image/jpeg";
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `inline; filename="${row.selfie_path}"`,
      "Cache-Control": "private, max-age=300"
    }
  });
}
