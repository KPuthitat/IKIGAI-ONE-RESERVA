import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// GET /api/health/exam-file/[id] — stream the uploaded exam file for a
// health_checkups row. Access: the employee whose record it is (own data)
// OR an admin / super_admin. Anyone else gets 403. Used by the staff
// self-view "ดูไฟล์ผลตรวจ" link and the admin health page.

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }
  const row = getDb().prepare(
    "SELECT user_id, file_path, file_mime FROM health_checkups WHERE id = ?"
  ).get(id) as { user_id: number; file_path: string | null; file_mime: string | null } | undefined;
  if (!row || !row.file_path) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const isOwner = row.user_id === user.id;
  const isAdmin = user.role === "admin" || user.role === "super_admin";
  if (!isOwner && !isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const buf = await fs.readFile(row.file_path);
    const arr = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    return new Response(arr, {
      headers: {
        "Content-Type": row.file_mime ?? "application/octet-stream",
        "Content-Disposition": "inline",
        "Cache-Control": "private, no-store"
      }
    });
  } catch {
    return NextResponse.json({ error: "file_missing" }, { status: 404 });
  }
}
