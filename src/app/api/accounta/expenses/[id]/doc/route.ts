import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { requirePermission } from "@/lib/auth";
import { getExpenseDoc, setExpenseDoc, getExpense } from "@/lib/accounta-db";
import { syncReceiptToDrive } from "@/lib/google-drive";

// GET  /api/accounta/expenses/[id]/doc — stream the stored receipt image
// POST /api/accounta/expenses/[id]/doc — attach/replace a receipt image
//
// Files live under data/accounta/receipts/ (outside www-root, like the
// RECRUITA documents). Path + mime recorded on the expense row.

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "application/pdf"]);
const DATA_ROOT = process.env.ACCOUNTA_DATA_ROOT ?? path.join(process.cwd(), "data", "accounta");
const RECEIPT_DIR = path.join(DATA_ROOT, "receipts");

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  requirePermission("accounta.manage");
  const id = parseId(params.id);
  if (id == null) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const doc = getExpenseDoc(id);
  if (!doc?.doc_path) return NextResponse.json({ error: "no_doc" }, { status: 404 });
  let buf: Buffer;
  try { buf = await fs.readFile(doc.doc_path); }
  catch { return NextResponse.json({ error: "file_missing" }, { status: 404 }); }
  // Copy into a fresh, plain ArrayBuffer — ArrayBuffer is an unambiguous
  // BodyInit and sidesteps Buffer's SharedArrayBuffer-backing variance.
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return new Response(ab, {
    status: 200,
    headers: {
      "Content-Type": doc.doc_mime || "application/octet-stream",
      "Content-Disposition": 'inline; filename="receipt"',
      "Cache-Control": "private, max-age=300"
    }
  });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  requirePermission("accounta.manage");
  const id = parseId(params.id);
  if (id == null) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  if (!getExpense(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: "bad_form" }, { status: 400 }); }
  const file = form.get("image");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "no_file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "too_large", message: "ไฟล์เกิน 8 MB" }, { status: 400 });
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json({ error: "bad_type", message: "รองรับเฉพาะรูป PNG / JPG / WebP หรือไฟล์ PDF" }, { status: 400 });
  }

  await fs.mkdir(RECEIPT_DIR, { recursive: true });
  const ext = (file.name.match(/\.[A-Za-z0-9]+$/)?.[0] ?? "").slice(0, 8) ||
    (file.type === "application/pdf" ? ".pdf"
      : file.type === "image/png" ? ".png"
      : file.type === "image/webp" ? ".webp" : ".jpg");
  const fullPath = path.join(RECEIPT_DIR, `bill-${id}-${randomBytes(6).toString("hex")}${ext}`);
  await fs.writeFile(fullPath, Buffer.from(await file.arrayBuffer()));

  // Best-effort removal of the previous file so we don't orphan it.
  const prev = getExpenseDoc(id);
  if (prev?.doc_path && prev.doc_path !== fullPath) {
    try { await fs.unlink(prev.doc_path); } catch { /* already gone */ }
  }
  setExpenseDoc(id, fullPath, file.type);
  // If this bill is already confirmed, sync the freshly-attached receipt to
  // the branch Drive (no-op for drafts / branches without Drive config).
  await syncReceiptToDrive(id);
  return NextResponse.json({ ok: true, mime: file.type });
}
