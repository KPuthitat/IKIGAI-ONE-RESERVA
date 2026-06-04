import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { requireAdmin } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// POST /api/recruita/applications/[id]/health
//
// Record the post-interview medical check (owner 2026-06-04). Multipart:
//   status      : 'pending' | 'passed' | 'failed'   (required)
//   provider    : 'self' | 'at_home'                (optional)
//   checked_at  : 'YYYY-MM-DD'                       (optional)
//   note        : free text ≤ 500                   (optional)
//   result      : optional File (PDF / image) — the lab/clinic result,
//                 saved as a candidate document with kind='health_result'.
//
// Hiring stays blocked until status='passed' (enforced again in the hire
// route). Admin-gated + audited.

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic"
]);
const DATA_ROOT = process.env.RECRUITA_DATA_ROOT
  ?? path.join(process.cwd(), "data", "recruita");

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = requireAdmin();
  const appId = Number(params.id);
  if (!Number.isInteger(appId) || appId <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: "expected_multipart" }, { status: 400 }); }

  const status = String(form.get("status") ?? "");
  const providerRaw = String(form.get("provider") ?? "");
  const checkedAtRaw = String(form.get("checked_at") ?? "");
  const note = String(form.get("note") ?? "").slice(0, 500).trim();
  if (!["pending", "passed", "failed"].includes(status)) {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }
  const provider = providerRaw === "at_home" || providerRaw === "self" ? providerRaw : null;
  const checkedAt = /^\d{4}-\d{2}-\d{2}$/.test(checkedAtRaw) ? checkedAtRaw : null;

  const db = getDb();
  const app = db.prepare(
    "SELECT id, candidate_id FROM recruita_applications WHERE id = ?"
  ).get(appId) as { id: number; candidate_id: number } | undefined;
  if (!app) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Optional result file → stored as a candidate document.
  const file = form.get("result");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "file_too_large" }, { status: 400 });
    }
    if (!ALLOWED_MIME.has(file.type)) {
      return NextResponse.json({ error: "bad_file_type" }, { status: 400 });
    }
    const dir = path.join(DATA_ROOT, String(app.candidate_id));
    await fs.mkdir(dir, { recursive: true });
    const ext = (file.name.match(/\.[A-Za-z0-9]+$/)?.[0] ?? "").slice(0, 8) || ".bin";
    const fullPath = path.join(dir, `health_result-${randomBytes(8).toString("hex")}${ext}`);
    await fs.writeFile(fullPath, Buffer.from(await file.arrayBuffer()));
    db.prepare(`
      INSERT INTO recruita_documents
        (candidate_id, kind, original_filename, mime_type, size_bytes, stored_path)
      VALUES (?, 'health_result', ?, ?, ?, ?)
    `).run(app.candidate_id, file.name.slice(0, 200), file.type, file.size, fullPath);
  }

  db.prepare(`
    UPDATE recruita_applications
    SET health_check_status = ?, health_check_provider = ?,
        health_check_at = ?, health_check_note = ?, health_checked_by = ?
    WHERE id = ?
  `).run(status, provider, checkedAt, note || null, user.id, appId);

  logPersonaAction(user.id, "recruita.health_check", appId);
  return NextResponse.json({ ok: true });
}
