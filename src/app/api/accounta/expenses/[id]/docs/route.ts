import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getExpense, addExpenseDoc, listExpenseDocs } from "@/lib/accounta-db";
import { saveReceiptImage, RECEIPT_ALLOWED_MIME, RECEIPT_MAX_BYTES } from "@/lib/accounta-receipts";
import { syncReceiptToDrive } from "@/lib/google-drive";

// GET  /api/accounta/expenses/[id]/docs — list extra attachments (metadata)
// POST /api/accounta/expenses/[id]/docs — add one extra attachment (multipart:
//   file, [label]). The primary receipt still lives on the expense itself;
//   these are additional evidence (slips, a second invoice, …).

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  requirePermission("accounta.manage");
  const id = parseId(params.id);
  if (id == null) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  return NextResponse.json({ ok: true, docs: listExpenseDocs(id) });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = requirePermission("accounta.manage");
  const id = parseId(params.id);
  if (id == null) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  if (!getExpense(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: "bad_form" }, { status: 400 }); }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "no_file" }, { status: 400 });
  }
  if (file.size > RECEIPT_MAX_BYTES) {
    return NextResponse.json({ error: "too_large", message: "ไฟล์เกิน 8 MB" }, { status: 400 });
  }
  const mime = file.type === "image/jpg" ? "image/jpeg" : file.type;
  if (!RECEIPT_ALLOWED_MIME.has(mime)) {
    return NextResponse.json({ error: "bad_type", message: "รองรับเฉพาะรูป PNG / JPG / WebP หรือไฟล์ PDF" }, { status: 400 });
  }
  const label = String(form.get("label") || "").trim().slice(0, 80) || null;

  const buf = Buffer.from(await file.arrayBuffer());
  const path = await saveReceiptImage(buf, mime, `${id}-extra`);
  const docId = addExpenseDoc(id, path, mime, label, user.id);

  // Push to the branch Drive too (no-op for drafts / branches without Drive).
  await syncReceiptToDrive(id);
  return NextResponse.json({ ok: true, id: docId });
}
