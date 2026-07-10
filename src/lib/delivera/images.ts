// ── DELIVERA — image storage (server-only) ─────────────────────────
// Menu photos and a store's PromptPay QR image live under data/delivera/images/
// (outside www-root, like ACCOUNTA receipts). Unlike receipts these are shown to
// customers in the public LIFF, so they're served by a PUBLIC route
// (/api/delivera/image/[name]) rather than a permission-gated one. We store the
// public URL in the DB (delivera_menu_items.image_url / settings.promptpay_qr_url)
// and reconstruct the disk path from the filename on read.

import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";

const DATA_ROOT = process.env.DELIVERA_DATA_ROOT ?? path.join(process.cwd(), "data", "delivera");
export const DELIVERA_IMAGE_DIR = path.join(DATA_ROOT, "images");

export const DELIVERA_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const DELIVERA_IMAGE_ALLOWED_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

function extForMime(mime: string): string {
  return mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : ".jpg";
}

/** Only a bare filename (no path separators / traversal) is ever accepted. */
export function isSafeImageName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.includes("..");
}

export function imageDiskPath(name: string): string {
  return path.join(DELIVERA_IMAGE_DIR, name);
}

/** Persist an image buffer and return its PUBLIC url (stored in the DB).
 *  `hint` only shapes the filename for readability (e.g. "menu-12", "qr-3"). */
export async function saveDeliveraImage(buf: Buffer, mime: string, hint: string): Promise<string> {
  await fs.mkdir(DELIVERA_IMAGE_DIR, { recursive: true });
  const safeHint = hint.replace(/[^A-Za-z0-9-]/g, "").slice(0, 24) || "img";
  const name = `${safeHint}-${randomBytes(6).toString("hex")}${extForMime(mime)}`;
  await fs.writeFile(path.join(DELIVERA_IMAGE_DIR, name), buf);
  return `/api/delivera/image/${name}`;
}

/** Best-effort delete of a previously stored image (given its public url). */
export async function deleteDeliveraImage(publicUrl: string | null | undefined): Promise<void> {
  if (!publicUrl) return;
  const name = publicUrl.split("/").pop();
  if (!name || !isSafeImageName(name)) return;
  try { await fs.unlink(imageDiskPath(name)); } catch { /* already gone */ }
}
