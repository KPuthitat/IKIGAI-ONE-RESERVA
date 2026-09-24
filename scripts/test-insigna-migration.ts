// Regression for the prod boot outage 2026-09-24: insigna_review_requests
// already existed WITHOUT customer_hash (as shipped by #351/#352), and a
// later migration created an index on customer_hash inside the same exec as
// the (now no-op) CREATE TABLE — so it threw "no such column: customer_hash"
// at boot and locked everyone out. This test seeds the OLD schema, then runs
// the real migrations, and asserts they heal it instead of throwing.
//
// Run:  node --import tsx scripts/test-insigna-migration.ts

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const TMP = path.join(process.cwd(), "data", "test-insigna-migration.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });

// Seed ONLY the pre-customer_hash insigna_review_requests table on a raw DB,
// then close it. We deliberately DON'T seed branches et al. — runMigrations
// builds the rest of the schema itself, exactly as it would on prod where
// insigna_review_requests is the one table already present in its old shape.
const seed = new Database(TMP);
seed.exec(`
  CREATE TABLE insigna_review_requests (
    token TEXT PRIMARY KEY,
    branch_id INTEGER,
    rating INTEGER NOT NULL,
    food_rating INTEGER, service_rating INTEGER, ambience_rating INTEGER,
    return_intent INTEGER, comment TEXT,
    tier TEXT NOT NULL,
    routed_google INTEGER NOT NULL DEFAULT 0,
    clicked_google INTEGER NOT NULL DEFAULT 0,
    reward_code TEXT, reward_claimed INTEGER NOT NULL DEFAULT 0, reward_claimed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);
const beforeCols = (seed.prepare("PRAGMA table_info(insigna_review_requests)").all() as Array<{ name: string }>).map((c) => c.name);
seed.close();

process.env.DATABASE_PATH = TMP;
process.env.INSIGNA_SALT = "test-salt-test-salt-test-salt-1234";

(async () => {
  let passed = 0, failed = 0;
  const ok = (name: string, cond: boolean) => {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ FAIL: ${name}`); }
  };

  ok("precondition: seeded table has NO customer_hash", !beforeCols.includes("customer_hash"));

  let threw: string | null = null;
  let cols: string[] = [];
  let hasIndex = false;
  try {
    const { getDb } = await import("../src/lib/db");
    const db = getDb(); // runs the real migrations against the pre-existing table
    cols = (db.prepare("PRAGMA table_info(insigna_review_requests)").all() as Array<{ name: string }>).map((c) => c.name);
    hasIndex = !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_insigna_review_customer'"
    ).get();
    // review_invites lives after the review table in the same exec — prove it
    // got created too (it wouldn't have, pre-fix, since the exec threw earlier).
    const hasInvites = !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_invites'"
    ).get();
    ok("review_invites table created", hasInvites);
  } catch (e) {
    threw = (e as Error).message;
  }

  ok("migrations do NOT throw on an existing table", threw === null);
  if (threw) console.error("     → threw:", threw);
  ok("customer_hash column added by the ALTER guard", cols.includes("customer_hash"));
  ok("customer_hash index created (after the column exists)", hasIndex);

  console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})();
