import { NextResponse } from "next/server";
import fs from "node:fs";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getAttachmentPath } from "@/lib/leave";

// GET /api/persona/leave/[id]/attachment — serve evidence file
// staff อ่านได้เฉพาะของตัวเอง · admin อ่านได้ทั้งหมด
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const row = getDb().prepare(
    "SELECT user_id, evidence_filename FROM leave_requests WHERE id = ?"
  ).get(id) as { user_id: number; evidence_filename: string | null } | undefined;

  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!row.evidence_filename) {
    return NextResponse.json({ error: "no_attachment" }, { status: 404 });
  }
  if (user.role !== "admin" && user.role !== "super_admin" && row.user_id !== user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

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
