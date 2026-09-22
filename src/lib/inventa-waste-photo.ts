// INVENTA waste evidence photo storage (owner 2026-09-22, server-only).
//
// Staff can attach a photo of the wasted item. The phone captures it, the client
// downscales it to a data-URL, and this decodes + writes it to disk under
// data/uploads/waste — only the filename is stored in inventa_waste.photo_path.
// Mirrors the clock-selfie helper (same on-disk convention + traversal guard),
// but these are pictures of stock, not faces, so no PDPA retention sweep.

import fs from "fs";
import path from "path";

const WASTE_PHOTO_DIR = process.env.INVENTA_WASTE_PHOTO_DIR
  || path.join(process.cwd(), "data", "uploads", "waste");

// Client downscales to ~long-edge 1280 JPEG (~150–400KB); cap generously.
const MAX_BYTES = 2 * 1024 * 1024;

/** Decode a `data:image/(jpeg|webp|png);base64,...` photo and write it to disk.
 *  Returns the stored filename, or an error code. */
export function saveWastePhoto(
  dataUrl: string
): { ok: true; filename: string } | { ok: false; error: string } {
  const m = /^data:image\/(jpeg|jpg|webp|png);base64,([A-Za-z0-9+/=]+)$/.exec((dataUrl || "").trim());
  if (!m) return { ok: false, error: "photo_bad_format" };
  const ext = m[1] === "webp" ? "webp" : m[1] === "png" ? "png" : "jpg";
  let buf: Buffer;
  try { buf = Buffer.from(m[2], "base64"); } catch { return { ok: false, error: "photo_bad_format" }; }
  if (buf.length === 0) return { ok: false, error: "photo_bad_format" };
  if (buf.length > MAX_BYTES) return { ok: false, error: "photo_too_large" };

  if (!fs.existsSync(WASTE_PHOTO_DIR)) fs.mkdirSync(WASTE_PHOTO_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  const filename = `${ts}_${rand}.${ext}`;
  fs.writeFileSync(path.join(WASTE_PHOTO_DIR, filename), buf);
  return { ok: true, filename };
}

/** Resolve a stored waste-photo filename to an absolute path, guarding traversal. */
export function getWastePhotoPath(filename: string): string | null {
  if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..")) return null;
  const full = path.join(WASTE_PHOTO_DIR, filename);
  if (!fs.existsSync(full)) return null;
  return full;
}

/** Delete a stored waste photo (best-effort) — used to clean up a file whose
 *  waste row failed to insert, so a rejected submit doesn't orphan it on disk. */
export function removeWastePhoto(filename: string): void {
  const full = getWastePhotoPath(filename);
  if (full) { try { fs.unlinkSync(full); } catch { /* already gone */ } }
}
