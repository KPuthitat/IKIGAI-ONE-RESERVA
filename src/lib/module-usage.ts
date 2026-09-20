// Per-user module usage (owner 2026-09-20): count how often each person opens
// each module so the landing page can order their cards by what they use most.
// Best-effort telemetry only — reads and writes are wrapped so a failure here
// never breaks a page load or a navigation.

import { getDb } from "./db";

// module_key is a path segment (e.g. "persona", "reserva", "inventa"). Guard the
// value so a stray client payload can't write junk keys.
const KEY_RE = /^[a-z0-9_-]{1,40}$/;

/** Record one module open for a user. No-op on a bad key or any DB error. */
export function recordModuleVisit(userId: number, moduleKey: string): void {
  if (!Number.isInteger(userId) || userId <= 0 || !KEY_RE.test(moduleKey)) return;
  try {
    getDb().prepare(
      `INSERT INTO module_usage (user_id, module_key, hits, last_at)
       VALUES (?, ?, 1, datetime('now'))
       ON CONFLICT(user_id, module_key) DO UPDATE SET hits = hits + 1, last_at = datetime('now')`
    ).run(userId, moduleKey);
  } catch { /* telemetry only — never surface */ }
}

/** Hit counts for a user keyed by module_key. Empty map on any error. */
export function moduleHits(userId: number): Map<string, number> {
  try {
    const rows = getDb().prepare(
      "SELECT module_key, hits FROM module_usage WHERE user_id = ?"
    ).all(userId) as Array<{ module_key: string; hits: number }>;
    return new Map(rows.map((r) => [r.module_key, r.hits]));
  } catch { return new Map(); }
}
