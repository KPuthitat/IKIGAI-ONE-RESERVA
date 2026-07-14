// Clock-in selfie storage (owner 2026-07-14, "own-device" anti-cheat).
//
// When a branch has clock_selfie_enabled=1, the staff's phone captures a selfie
// at clock-in; it's downscaled client-side and sent as a data-URL, decoded here
// and written to disk. Only the filename is stored in time_entries.selfie_path;
// bytes live under data/uploads/selfie. Mirrors the leave-attachment helpers
// (src/lib/leave.ts) — same on-disk convention, traversal guard, and a tight
// size cap because there's one selfie per punch on a small VPS.
//
// Retention: a cron sweep (src/app/api/cron/route.ts) unlinks files older than
// CLOCK_SELFIE_RETENTION_DAYS — face images are PDPA-sensitive, keep only what's
// needed for dispute review.

import fs from "fs";
import path from "path";

const SELFIE_DIR = process.env.CLOCK_SELFIE_DIR
  || path.join(process.cwd(), "data", "uploads", "selfie");

// Downscaled JPEG selfies land ~100–200KB; cap generously but well under the
// leave 3MB so a raw upload can't bloat the disk.
const MAX_BYTES = 512 * 1024;
export const CLOCK_SELFIE_RETENTION_DAYS = 60;

/** Decode a `data:image/jpeg;base64,...` (or webp) selfie and write it to disk.
 *  Returns the stored filename, or an error code. Rejects anything that isn't a
 *  small jpeg/webp so a client can't smuggle a huge or wrong-type payload. */
export function saveClockSelfie(
  userId: number,
  dataUrl: string
): { ok: true; filename: string } | { ok: false; error: string } {
  const m = /^data:image\/(jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec((dataUrl || "").trim());
  if (!m) return { ok: false, error: "selfie_bad_format" };
  const ext = m[1] === "webp" ? "webp" : "jpg";
  let buf: Buffer;
  try {
    buf = Buffer.from(m[2], "base64");
  } catch {
    return { ok: false, error: "selfie_bad_format" };
  }
  if (buf.length === 0) return { ok: false, error: "selfie_bad_format" };
  if (buf.length > MAX_BYTES) return { ok: false, error: "selfie_too_large" };

  if (!fs.existsSync(SELFIE_DIR)) fs.mkdirSync(SELFIE_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  const filename = `${userId}_${ts}_${rand}.${ext}`;
  fs.writeFileSync(path.join(SELFIE_DIR, filename), buf);
  return { ok: true, filename };
}

/** Resolve a stored selfie filename to an absolute path, guarding traversal. */
export function getClockSelfiePath(filename: string): string | null {
  if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    return null;
  }
  const full = path.join(SELFIE_DIR, filename);
  if (!fs.existsSync(full)) return null;
  return full;
}

/** Delete selfie files older than the retention window. Returns how many were
 *  removed. Called from the cron route. Best-effort — ignores unlink races. */
export function purgeOldClockSelfies(nowMs: number, retentionDays = CLOCK_SELFIE_RETENTION_DAYS): number {
  if (!fs.existsSync(SELFIE_DIR)) return 0;
  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of fs.readdirSync(SELFIE_DIR)) {
    const full = path.join(SELFIE_DIR, name);
    try {
      const st = fs.statSync(full);
      if (st.isFile() && st.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed++;
      }
    } catch {
      // file vanished mid-sweep or unreadable — skip
    }
  }
  return removed;
}
