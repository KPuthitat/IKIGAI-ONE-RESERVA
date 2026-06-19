// ── ACCOUNTA — receipt image storage (server-only) ─────────────────
// Receipt/bill images live under data/accounta/receipts/ (outside www-root,
// like RECRUITA documents). Shared by the in-app upload route and the LINE
// bill-ingest path so both write to the same place with the same naming.

import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";

const DATA_ROOT = process.env.ACCOUNTA_DATA_ROOT ?? path.join(process.cwd(), "data", "accounta");
const RECEIPT_DIR = path.join(DATA_ROOT, "receipts");

export const RECEIPT_MAX_BYTES = 8 * 1024 * 1024;
export const RECEIPT_ALLOWED_MIME = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/webp", "application/pdf"
]);

function extForMime(mime: string): string {
  return mime === "application/pdf" ? ".pdf"
    : mime === "image/png" ? ".png"
    : mime === "image/webp" ? ".webp"
    : ".jpg";
}

/** Persist a receipt image buffer; returns its absolute path on disk.
 *  `idHint` only shapes the filename for human readability. */
export async function saveReceiptImage(
  buf: Buffer,
  mime: string,
  idHint: string | number
): Promise<string> {
  await fs.mkdir(RECEIPT_DIR, { recursive: true });
  const fullPath = path.join(
    RECEIPT_DIR,
    `bill-${idHint}-${randomBytes(6).toString("hex")}${extForMime(mime)}`
  );
  await fs.writeFile(fullPath, buf);
  return fullPath;
}
