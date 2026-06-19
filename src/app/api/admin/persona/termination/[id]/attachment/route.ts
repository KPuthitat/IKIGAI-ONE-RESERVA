import { NextResponse } from "next/server";
import fs from "node:fs";
import { getSessionUser } from "@/lib/auth";
import { getAttachmentPath } from "@/lib/leave";
import { getTermination } from "@/lib/termination";

// GET /api/admin/persona/termination/[id]/attachment — serve the
// termination evidence file. Admin / super_admin only (termination
// records are HR-sensitive; there's no staff-facing view).
export async function GET(_req: Request, { params }: { params: { id: string } }) {
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
  if (!row.evidence_filename) return NextResponse.json({ error: "no_attachment" }, { status: 404 });

  const fullPath = getAttachmentPath(row.evidence_filename);
  if (!fullPath) return NextResponse.json({ error: "file_missing" }, { status: 404 });

  const buf = fs.readFileSync(fullPath);
  const ext = (row.evidence_filename.split(".").pop() || "").toLowerCase();
  const contentType =
    ext === "pdf" ? "application/pdf" :
    ext === "png" ? "image/png" :
    ext === "webp" ? "image/webp" :
    ext === "heic" || ext === "heif" ? "image/heic" :
    "image/jpeg";

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `inline; filename="${row.evidence_filename}"`,
      "Cache-Control": "private, max-age=300"
    }
  });
}
