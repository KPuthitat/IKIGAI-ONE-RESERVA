import { promises as fs } from "fs";
import path from "path";
import { getDb } from "./db";

// PDPA retention for RECRUITA. Rejected/withdrawn applications are
// purged 30 days after the candidate APPLIED (submitted_at) — the owner's
// rule (2026-06-14): no rejected/withdrawn record may live past 30 days
// from application. NOTE: a record that's already >30 days old when it
// reaches rejected/withdrawn is purged on the very next cron run.
// This is what the admin UI's "เหลือ X วันก่อนลบ" countdown promises.
//
// When a candidate has NO remaining applications after the purge, we
// also delete their candidate row + uploaded document files (photo /
// resume / id-copy) so no orphaned personal data lingers. Candidates
// who still have a live application elsewhere are kept.

const RETENTION_DAYS = 30;
const DATA_ROOT =
  process.env.RECRUITA_DATA_ROOT ?? path.join(process.cwd(), "data", "recruita");

export async function purgeOldRecruitaApplications(): Promise<{
  apps: number;
  candidates: number;
  files: number;
}> {
  const db = getDb();

  // SQLite stores submitted_at as UTC "YYYY-MM-DD HH:MM:SS"; let SQLite do
  // the date math so we don't fight timezone/format mismatches.
  const stale = db.prepare(`
    SELECT id, candidate_id
    FROM recruita_applications
    WHERE stage IN ('rejected', 'withdrawn')
      AND submitted_at IS NOT NULL
      AND submitted_at < datetime('now', '-${RETENTION_DAYS} days')
  `).all() as Array<{ id: number; candidate_id: number }>;

  if (stale.length === 0) return { apps: 0, candidates: 0, files: 0 };

  const delApp = db.prepare("DELETE FROM recruita_applications WHERE id = ?");
  const affected = new Set<number>();
  for (const row of stale) {
    delApp.run(row.id);
    affected.add(row.candidate_id);
  }

  // For each affected candidate with no remaining applications, purge
  // their documents (files on disk + rows) and the candidate row.
  const remainingStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM recruita_applications WHERE candidate_id = ?"
  );
  const docsStmt = db.prepare(
    "SELECT stored_path FROM recruita_documents WHERE candidate_id = ?"
  );
  const delDocs = db.prepare("DELETE FROM recruita_documents WHERE candidate_id = ?");
  const delCand = db.prepare("DELETE FROM recruita_candidates WHERE id = ?");

  let candidatesDeleted = 0;
  let filesDeleted = 0;
  for (const cid of affected) {
    const remaining = (remainingStmt.get(cid) as { n: number }).n;
    if (remaining > 0) continue; // still has a live application — keep

    const docs = docsStmt.all(cid) as Array<{ stored_path: string }>;
    for (const d of docs) {
      try { await fs.unlink(d.stored_path); filesDeleted++; } catch { /* already gone */ }
    }
    delDocs.run(cid);
    delCand.run(cid);
    candidatesDeleted++;

    // Best-effort: remove the now-empty per-candidate upload directory.
    try { await fs.rmdir(path.join(DATA_ROOT, String(cid))); } catch { /* not empty / missing */ }
  }

  console.info(
    `[recruita] PDPA purge: removed ${stale.length} application(s), ` +
    `${candidatesDeleted} candidate(s), ${filesDeleted} file(s)`
  );
  return { apps: stale.length, candidates: candidatesDeleted, files: filesDeleted };
}
