import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";

// GET /api/recruita/documents/[id]
//
// Streams a saved applicant document (resume / photo / id_copy)
// back to the admin. Super-admin gated because these include
// identity documents. The actual file lives outside the public
// www-root (under data/recruita/...) so it can't be reached via
// a guessed URL.

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  requireAdmin();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  const row = db.prepare(`
    SELECT stored_path, mime_type, original_filename
    FROM recruita_documents WHERE id = ?
  `).get(id) as {
    stored_path: string; mime_type: string | null; original_filename: string | null
  } | undefined;
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const buf = await fs.readFile(row.stored_path);
    const arr = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    return new Response(arr, {
      headers: {
        "Content-Type": row.mime_type ?? "application/octet-stream",
        "Content-Disposition": `inline; filename="${encodeURIComponent(row.original_filename ?? `doc-${id}`)}"`,
        "Cache-Control": "private, no-store"
      }
    });
  } catch {
    return NextResponse.json({ error: "file_missing" }, { status: 410 });
  }
}
