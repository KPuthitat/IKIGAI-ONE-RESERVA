import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { requirePermission } from "@/lib/auth";
import { getExpenseDocRow, deleteExpenseDocRow } from "@/lib/accounta-db";

// GET    /api/accounta/expenses/[id]/docs/[docId] — stream one extra attachment
// DELETE /api/accounta/expenses/[id]/docs/[docId] — remove it (+ unlink file)

function contentTypeFor(path: string, mime: string | null): string {
  if (mime) return mime;
  const ext = (path.split(".").pop() || "").toLowerCase();
  return ext === "pdf" ? "application/pdf"
    : ext === "png" ? "image/png"
    : ext === "webp" ? "image/webp"
    : "image/jpeg";
}

export async function GET(_req: Request, { params }: { params: { id: string; docId: string } }) {
  requirePermission("accounta.manage");
  const docId = Number(params.docId);
  if (!Number.isInteger(docId) || docId <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const row = getExpenseDocRow(docId);
  if (!row || String(row.expense_id) !== params.id) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let buf: Buffer;
  try { buf = await fs.readFile(row.doc_path); }
  catch { return NextResponse.json({ error: "file_missing" }, { status: 404 }); }
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return new Response(ab, {
    status: 200,
    headers: {
      "Content-Type": contentTypeFor(row.doc_path, row.doc_mime),
      "Content-Disposition": 'inline; filename="attachment"',
      "Cache-Control": "private, max-age=300"
    }
  });
}

export async function DELETE(_req: Request, { params }: { params: { id: string; docId: string } }) {
  requirePermission("accounta.manage");
  const docId = Number(params.docId);
  if (!Number.isInteger(docId) || docId <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const row = getExpenseDocRow(docId);
  if (!row || String(row.expense_id) !== params.id) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const path = deleteExpenseDocRow(docId);
  if (path) { try { await fs.unlink(path); } catch { /* already gone */ } }
  return NextResponse.json({ ok: true });
}
