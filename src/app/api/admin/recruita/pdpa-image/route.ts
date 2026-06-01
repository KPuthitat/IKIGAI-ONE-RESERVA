import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { getSessionUser } from "@/lib/auth";
import { getDb, getSystemSettings, logPersonaAction } from "@/lib/db";

// POST   /api/admin/recruita/pdpa-image  — upload (super-admin)
// DELETE /api/admin/recruita/pdpa-image  — remove  (super-admin)
//
// Stores the PDPA policy image under data/recruita/_pdpa/ (outside the
// www-root, like applicant documents) and records its absolute path +
// mime on the system_settings singleton. The public apply form links
// to /api/recruita/pdpa-image to display it. Images only (PNG/JPG/WebP)
// per owner spec; capped at 8 MB.

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
const DATA_ROOT =
  process.env.RECRUITA_DATA_ROOT ?? path.join(process.cwd(), "data", "recruita");
const PDPA_DIR = path.join(DATA_ROOT, "_pdpa");

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_form" }, { status: 400 });
  }
  const file = form.get("image");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ ok: false, error: "no_file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: "too_large", message: "ไฟล์เกิน 8 MB" },
      { status: 400 }
    );
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json(
      { ok: false, error: "bad_type", message: "รองรับเฉพาะรูปภาพ PNG / JPG / WebP" },
      { status: 400 }
    );
  }

  await fs.mkdir(PDPA_DIR, { recursive: true });
  const ext =
    (file.name.match(/\.[A-Za-z0-9]+$/)?.[0] ?? "").slice(0, 8) ||
    (file.type === "image/png" ? ".png" : file.type === "image/webp" ? ".webp" : ".jpg");
  const filename = `pdpa-${randomBytes(8).toString("hex")}${ext}`;
  const fullPath = path.join(PDPA_DIR, filename);
  const buf = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(fullPath, buf);

  // Best-effort removal of the previous image so we don't orphan files.
  const prev = getSystemSettings().recruita_pdpa_image_path;
  if (prev && prev !== fullPath) {
    try { await fs.unlink(prev); } catch { /* already gone — ignore */ }
  }

  getDb().prepare(`
    UPDATE system_settings
       SET recruita_pdpa_image_path = ?,
           recruita_pdpa_image_mime = ?,
           updated_at = CURRENT_TIMESTAMP,
           updated_by = ?
     WHERE id = 1
  `).run(fullPath, file.type, user.id);

  logPersonaAction(user.id, "system_settings.pdpa_image_upload", null);
  return NextResponse.json({ ok: true, mime: file.type });
}

export async function DELETE() {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const prev = getSystemSettings().recruita_pdpa_image_path;
  if (prev) {
    try { await fs.unlink(prev); } catch { /* already gone — ignore */ }
  }
  getDb().prepare(`
    UPDATE system_settings
       SET recruita_pdpa_image_path = NULL,
           recruita_pdpa_image_mime = NULL,
           updated_at = CURRENT_TIMESTAMP,
           updated_by = ?
     WHERE id = 1
  `).run(user.id);

  logPersonaAction(user.id, "system_settings.pdpa_image_delete", null);
  return NextResponse.json({ ok: true });
}
