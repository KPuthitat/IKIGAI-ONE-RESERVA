import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// POST /api/admin/persona/health/[id]/file — attach the actual exam result
// file (PDF / image) to a health_checkups row (owner 2026-06-05). Admin or
// super_admin only. Files live under data/health/_exams/ (outside the
// www-root, like applicant docs) and are served via the auth-gated
// /api/health/exam-file/[id] route. The legacy attachment_url (a Drive
// link) still works for older rows.

const MAX_BYTES = 12 * 1024 * 1024; // 12 MB — lab PDFs can be a few MB
const ALLOWED_MIME = new Set([
  "application/pdf", "image/jpeg", "image/jpg", "image/png", "image/webp"
]);
const DATA_ROOT = process.env.HEALTH_DATA_ROOT ?? path.join(process.cwd(), "data", "health");
const EXAM_DIR = path.join(DATA_ROOT, "_exams");

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 });
  }
  const db = getDb();
  const row = db.prepare("SELECT id, file_path FROM health_checkups WHERE id = ?")
    .get(id) as { id: number; file_path: string | null } | undefined;
  if (!row) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ ok: false, error: "bad_form" }, { status: 400 }); }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ ok: false, error: "no_file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: "too_large", message: "ไฟล์เกิน 12 MB" }, { status: 400 });
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json({ ok: false, error: "bad_type", message: "รองรับเฉพาะ PDF / รูปภาพ" }, { status: 400 });
  }

  await fs.mkdir(EXAM_DIR, { recursive: true });
  const ext = file.type === "application/pdf" ? ".pdf"
    : file.type === "image/png" ? ".png"
    : file.type === "image/webp" ? ".webp" : ".jpg";
  const filename = `exam-${id}-${randomBytes(6).toString("hex")}${ext}`;
  const fullPath = path.join(EXAM_DIR, filename);
  await fs.writeFile(fullPath, Buffer.from(await file.arrayBuffer()));

  // Drop the previous file so we don't orphan it.
  if (row.file_path && row.file_path !== fullPath) {
    try { await fs.unlink(row.file_path); } catch { /* already gone */ }
  }

  db.prepare("UPDATE health_checkups SET file_path = ?, file_mime = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(fullPath, file.type, id);
  logPersonaAction(user.id, "health.file_upload", id);
  return NextResponse.json({ ok: true, mime: file.type });
}
