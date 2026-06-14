import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { getDb } from "@/lib/db";

// POST /api/recruita/my-applications/[id]/health-cert  (public, candidate)
//
// Candidate self-service upload of the medical certificate ("ใบรับรองแพทย์
// 5 โรค") while at the health_check stage (owner 2026-06-14). Multipart:
//   file          : the certificate photo / PDF        (required)
//   line_user_id  : LIFF-proven LINE userId            (identity)
//   mobile_phone  : phone used at apply time           (identity)
//
// Authorisation mirrors the interview-booking route: the requester must
// prove ownership by EITHER the LINE userId bound to the candidate OR the
// mobile phone on file. At least one must match. Allowed only while the
// application is at the health_check stage.
//
// The file is stored as a candidate document with kind='health_cert' —
// surfaced separately on the admin application-detail page so the admin
// sees the applicant's upload. We use a DISTINCT kind from the admin's own
// 'health_result' (lab result the admin attaches) so a candidate re-upload
// never clobbers an admin-attached file. A fresh upload REPLACES any prior
// 'health_cert' for this candidate so the admin always sees the latest.

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic"
]);
const DATA_ROOT = process.env.RECRUITA_DATA_ROOT
  ?? path.join(process.cwd(), "data", "recruita");

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const appId = Number(params.id);
  if (!Number.isInteger(appId) || appId <= 0) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  // Reject oversized bodies up-front by Content-Length so an unauthenticated
  // caller can't make us buffer a huge multipart body into memory (1 GB VPS)
  // before the size check. Allow ~1 MB of multipart overhead above the cap.
  const declaredLen = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLen) && declaredLen > MAX_FILE_BYTES + 1024 * 1024) {
    return NextResponse.json({ ok: false, error: "file_too_large", message: "ไฟล์ใหญ่เกิน 10MB" }, { status: 413 });
  }

  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ ok: false, error: "expected_multipart" }, { status: 400 }); }

  const lineUserId = String(form.get("line_user_id") ?? "").trim() || null;
  const mobilePhone = String(form.get("mobile_phone") ?? "").trim() || null;
  if (!lineUserId && !mobilePhone) {
    return NextResponse.json({ ok: false, error: "no_identity" }, { status: 400 });
  }
  if (lineUserId && !/^U[0-9a-fA-F]{32}$/.test(lineUserId)) {
    return NextResponse.json({ ok: false, error: "bad_identity" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ ok: false, error: "no_file" }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ ok: false, error: "file_too_large", message: "ไฟล์ใหญ่เกิน 10MB" }, { status: 400 });
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json({ ok: false, error: "bad_file_type", message: "รองรับเฉพาะรูปภาพหรือ PDF" }, { status: 400 });
  }

  const db = getDb();
  const app = db.prepare(`
    SELECT a.id, a.stage, a.candidate_id, c.line_user_id, c.mobile_phone
    FROM recruita_applications a
    JOIN recruita_candidates c ON c.id = a.candidate_id
    WHERE a.id = ?
  `).get(appId) as
    | { id: number; stage: string; candidate_id: number; line_user_id: string | null; mobile_phone: string | null }
    | undefined;
  if (!app) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  // Ownership — at least one identity proof must match the candidate.
  // Phone match requires a real ≥9-digit number on BOTH sides: norm()
  // strips non-digits, so without the length floor a junk value like "x"
  // (norm → "") would equal a candidate whose phone is NULL/empty and
  // bypass the check. line_user_id must be a non-null exact match.
  const lineMatches = !!lineUserId && app.line_user_id === lineUserId;
  const norm = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
  const phoneMatches = norm(mobilePhone).length >= 9 && norm(app.mobile_phone) === norm(mobilePhone);
  if (!lineMatches && !phoneMatches) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // Only while waiting on the medical check.
  if (app.stage !== "health_check") {
    return NextResponse.json(
      { ok: false, error: "stage_not_health", message: "ใบสมัครนี้ยังไม่อยู่ในขั้นตรวจสุขภาพ" },
      { status: 409 }
    );
  }

  // Write the new file FIRST, then swap the DB row + unlink the old file.
  // Doing the write before the delete means a failure can't leave the
  // candidate with neither the old nor the new certificate.
  const dir = path.join(DATA_ROOT, String(app.candidate_id));
  await fs.mkdir(dir, { recursive: true });
  const ext = (file.name.match(/\.[A-Za-z0-9]+$/)?.[0] ?? "").slice(0, 8) || ".bin";
  const fullPath = path.join(dir, `health_cert-${randomBytes(8).toString("hex")}${ext}`);
  await fs.writeFile(fullPath, Buffer.from(await file.arrayBuffer()));

  // Find prior health_cert docs to retire (latest upload wins). We use a
  // DISTINCT kind from the admin's 'health_result' so this never touches an
  // admin-attached file.
  const prior = db.prepare(
    "SELECT stored_path FROM recruita_documents WHERE candidate_id = ? AND kind = 'health_cert'"
  ).all(app.candidate_id) as Array<{ stored_path: string }>;
  const swap = db.transaction(() => {
    db.prepare("DELETE FROM recruita_documents WHERE candidate_id = ? AND kind = 'health_cert'")
      .run(app.candidate_id);
    db.prepare(`
      INSERT INTO recruita_documents
        (candidate_id, kind, original_filename, mime_type, size_bytes, stored_path)
      VALUES (?, 'health_cert', ?, ?, ?, ?)
    `).run(app.candidate_id, file.name.slice(0, 200), file.type, file.size, fullPath);
  });
  swap();
  // Only after the row swap committed, unlink the old files on disk.
  for (const d of prior) {
    try { await fs.unlink(d.stored_path); } catch { /* already gone */ }
  }

  console.info(`[recruita] candidate uploaded health cert → app #${appId}`);
  return NextResponse.json({ ok: true, filename: file.name.slice(0, 200) });
}
