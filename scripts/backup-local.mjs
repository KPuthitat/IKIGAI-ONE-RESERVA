// Local backup for the moved-to-D: dev environment.
//
// The project no longer lives under OneDrive, so the gitignored files
// (.env and data/reserva.db) have NO automatic cloud backup. This script
// snapshots them to a sibling folder outside the repo and prunes old runs.
//
// Usage:  npm run db:backup
// Config: BACKUP_DIR   — destination root (default: ../_reserva-backups)
//         BACKUP_KEEP  — how many timestamped runs to keep (default: 14)
//
// Uses the SQLite online-backup API so the snapshot is consistent even
// while `npm run dev` holds the DB open in WAL mode.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destRoot =
  process.env.BACKUP_DIR || path.resolve(repoRoot, "..", "_reserva-backups");
const keep = Number(process.env.BACKUP_KEEP || 14);

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

async function main() {
  const destDir = path.join(destRoot, stamp());
  fs.mkdirSync(destDir, { recursive: true });

  // 1) .env (plain copy — small text file)
  const envSrc = path.join(repoRoot, ".env");
  if (fs.existsSync(envSrc)) {
    fs.copyFileSync(envSrc, path.join(destDir, ".env"));
    console.log("  .env backed up");
  } else {
    console.log("  .env not found — skipped");
  }

  // 2) reserva.db (consistent online backup)
  const dbSrc = path.join(repoRoot, "data", "reserva.db");
  if (fs.existsSync(dbSrc)) {
    const db = new Database(dbSrc, { readonly: true });
    const dbDest = path.join(destDir, "reserva.db");
    await db.backup(dbDest);
    db.close();
    // Consolidate into a single self-contained file: the online backup
    // inherits the source's WAL mode, leaving -wal/-shm sidecars. Switching
    // the copy to DELETE journal mode merges them so the backup is one file.
    const v = new Database(dbDest);
    v.pragma("journal_mode = DELETE");
    const users = v.prepare("SELECT COUNT(*) c FROM users").get().c;
    v.close();
    console.log(`  reserva.db backed up (verified: ${users} users)`);
  } else {
    console.log("  data/reserva.db not found — skipped");
  }

  // 3) prune old runs, keep the newest `keep`
  const runs = fs
    .readdirSync(destRoot)
    .filter((n) => /^\d{8}-\d{6}$/.test(n))
    .sort();
  const stale = runs.slice(0, Math.max(0, runs.length - keep));
  for (const s of stale) {
    fs.rmSync(path.join(destRoot, s), { recursive: true, force: true });
  }
  if (stale.length) console.log(`  pruned ${stale.length} old backup(s)`);

  console.log(`backup OK → ${destDir}  (keeping last ${keep})`);
}

main().catch((e) => {
  console.error("backup FAILED:", e.message);
  process.exit(1);
});
