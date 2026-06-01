import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { getSystemSettings } from "@/lib/db";

// GET /api/recruita/pdpa-image
//
// Public — streams the admin-uploaded PDPA policy image so candidates
// can open it from the apply form's "เปิดดูนโยบาย" button. No auth: a
// privacy notice is meant to be public. The file lives outside the
// www-root; we read its path from system_settings and stream it.
//
// 404 when no image has been uploaded (apply form falls back to the
// default text and never links here in that case).

export const dynamic = "force-dynamic";

export async function GET() {
  const s = getSystemSettings();
  const p = s.recruita_pdpa_image_path;
  if (!p) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const buf = await fs.readFile(p);
    const arr = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    return new Response(arr, {
      headers: {
        "Content-Type": s.recruita_pdpa_image_mime ?? "image/jpeg",
        "Content-Disposition": 'inline; filename="pdpa-policy"',
        // Short public cache — admin edits are rare; apply page also
        // appends a ?v=<updated_at> cache-buster on the link.
        "Cache-Control": "public, max-age=300"
      }
    });
  } catch {
    return NextResponse.json({ error: "file_missing" }, { status: 410 });
  }
}
