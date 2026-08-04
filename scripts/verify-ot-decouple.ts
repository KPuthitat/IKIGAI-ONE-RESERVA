// Fixture: early/late OT segments are decoupled (owner 2026-08-04).
//
// Before this, ot_requests carried ONE `status` shared by both requested_until
// (late-end) and requested_from (early-start). Filing or deciding one segment
// silently reset the other — an approved early-in flipped back to pending the
// moment a late-OT request was filed for the same day. This fixture replicates
// the EXACT upsert/decide/loader SQL from the routes + payroll engine against an
// in-memory DB and asserts each segment is now independent.
//
// Run:  node --import tsx scripts/verify-ot-decouple.ts
import Database from "better-sqlite3";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

const db = new Database(":memory:");
// Mirror of the ot_requests schema in src/lib/db.ts (incl. the new early_status).
db.exec(`
  CREATE TABLE ot_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    branch_id INTEGER,
    work_date TEXT NOT NULL,
    requested_until TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','approved','rejected')),
    decided_by INTEGER,
    decided_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    requested_from TEXT,
    early_status TEXT,
    UNIQUE (user_id, work_date)
  );
`);

const U = 1, B = 1, ADMIN = 99;
const now = "2026-08-04T00:00:00.000Z";

// ── route replicas ──────────────────────────────────────────────
// Staff late-OT POST (/api/persona/ot-requests): touches only the late seg.
function fileLateStaff(userId: number, date: string, until: string) {
  db.prepare(`
    INSERT INTO ot_requests (user_id, branch_id, work_date, requested_until, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
    ON CONFLICT (user_id, work_date) DO UPDATE SET
      requested_until = excluded.requested_until,
      branch_id = excluded.branch_id,
      status = 'pending',
      decided_by = NULL,
      decided_at = NULL
  `).run(userId, B, date, until, now);
}
// Staff early-OT (attendance-resolve 'early'): touches only the early seg.
function fileEarlyStaff(userId: number, date: string, from: string) {
  db.prepare(`
    INSERT INTO ot_requests
      (user_id, branch_id, work_date, requested_until, requested_from, status, early_status, created_at)
    VALUES (?, ?, ?, '', ?, 'pending', 'pending', ?)
    ON CONFLICT (user_id, work_date) DO UPDATE SET
      requested_from = excluded.requested_from,
      early_status = 'pending',
      branch_id = excluded.branch_id
  `).run(userId, B, date, from, now);
}
// Admin decide (PATCH [id]): per-segment.
function decide(id: number, segment: "late" | "early", action: "approve" | "reject") {
  const s = action === "approve" ? "approved" : "rejected";
  if (segment === "early") {
    db.prepare("UPDATE ot_requests SET early_status = ?, decided_by = ?, decided_at = ? WHERE id = ?")
      .run(s, ADMIN, now, id);
  } else {
    db.prepare("UPDATE ot_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?")
      .run(s, ADMIN, now, id);
  }
}
// Admin manual add (POST): approves only the granted segment(s).
function adminAdd(userId: number, date: string, opts: { until?: string; from?: string }) {
  const existing = db.prepare(
    "SELECT requested_until, requested_from, status, early_status FROM ot_requests WHERE user_id = ? AND work_date = ?"
  ).get(userId, date) as
    | { requested_until: string; requested_from: string | null; status: string; early_status: string | null }
    | undefined;
  const finalUntil = opts.until ?? existing?.requested_until ?? "";
  const finalFrom = opts.from ?? existing?.requested_from ?? null;
  const finalStatus = opts.until ? "approved" : (existing?.status ?? "pending");
  const finalEarlyStatus = opts.from
    ? "approved"
    : (existing?.early_status ?? (finalFrom ? "pending" : null));
  db.prepare(`
    INSERT INTO ot_requests
      (user_id, branch_id, work_date, requested_until, requested_from, status, early_status, decided_by, decided_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, work_date) DO UPDATE SET
      requested_until = excluded.requested_until,
      requested_from = excluded.requested_from,
      branch_id = excluded.branch_id,
      status = excluded.status,
      early_status = excluded.early_status,
      decided_by = excluded.decided_by,
      decided_at = excluded.decided_at
  `).run(userId, B, date, finalUntil, finalFrom, finalStatus, finalEarlyStatus, ADMIN, now, now);
}
// Engine loader gating (payroll-compute): late by status, early by early_status.
function loadApproved(userId: number, date: string): { late: string | null; early: string | null } {
  const r = db.prepare(`
    SELECT requested_until, requested_from, status, early_status FROM ot_requests
    WHERE user_id = ? AND work_date = ? AND (status = 'approved' OR early_status = 'approved')
  `).get(userId, date) as
    | { requested_until: string; requested_from: string | null; status: string; early_status: string | null }
    | undefined;
  if (!r) return { late: null, early: null };
  return {
    late: r.status === "approved" && r.requested_until ? r.requested_until : null,
    early: r.early_status === "approved" && r.requested_from ? r.requested_from : null
  };
}
const getRow = (userId: number, date: string) =>
  db.prepare("SELECT * FROM ot_requests WHERE user_id = ? AND work_date = ?").get(userId, date) as {
    id: number; status: string; early_status: string | null;
    requested_until: string; requested_from: string | null;
  };

// ── THE BUG: approve early, then file a late-OT for the same day ──
{
  const D = "2026-08-10";
  fileEarlyStaff(U, D, "10:00");
  let row = getRow(U, D);
  assert(row.early_status === "pending" && row.status === "pending", "early filed → early_status pending");
  decide(row.id, "early", "approve");
  assert(getRow(U, D).early_status === "approved", "admin approves early → early_status approved");
  let ld = loadApproved(U, D);
  assert(ld.early === "10:00" && ld.late === null, "engine credits early only (no late yet)");

  // Staff now files a LATE OT for the same day — MUST NOT reset the approved early.
  fileLateStaff(U, D, "22:00");
  row = getRow(U, D);
  assert(row.early_status === "approved", "filing late OT does NOT reset approved early (bug fixed)");
  assert(row.status === "pending" && row.requested_until === "22:00", "late seg now pending @22:00");
  ld = loadApproved(U, D);
  assert(ld.early === "10:00" && ld.late === null, "early still credited; late pending → not credited");

  decide(row.id, "late", "approve");
  ld = loadApproved(U, D);
  assert(ld.early === "10:00" && ld.late === "22:00", "both segments credited after late approved");
}

// ── deciding one segment never disturbs the other ───────────────
{
  const D = "2026-08-11";
  fileEarlyStaff(U, D, "09:30");
  fileLateStaff(U, D, "21:00");            // both pending now
  let row = getRow(U, D);
  assert(row.early_status === "pending" && row.status === "pending", "both segments pending");
  decide(row.id, "late", "approve");        // approve late only
  row = getRow(U, D);
  assert(row.status === "approved" && row.early_status === "pending", "approve late leaves early pending");
  decide(row.id, "early", "reject");        // reject early only
  row = getRow(U, D);
  assert(row.status === "approved" && row.early_status === "rejected", "reject early leaves late approved");
  const ld = loadApproved(U, D);
  assert(ld.late === "21:00" && ld.early === null, "engine credits late; rejected early not credited");
}

// ── admin manual add: grant one side, then the other ────────────
{
  const D = "2026-08-12";
  adminAdd(U, D, { from: "08:00" });        // early only
  let row = getRow(U, D);
  assert(row.early_status === "approved" && row.requested_from === "08:00", "admin add early → early approved");
  assert(row.status !== "approved" || row.requested_until === "", "admin add early → late not granted");
  let ld = loadApproved(U, D);
  assert(ld.early === "08:00" && ld.late === null, "engine: early credited, late none");

  adminAdd(U, D, { until: "23:00" });       // now grant late on the SAME day
  row = getRow(U, D);
  assert(row.early_status === "approved", "granting late keeps early approved");
  assert(row.status === "approved" && row.requested_until === "23:00", "late now approved @23:00");
  ld = loadApproved(U, D);
  assert(ld.early === "08:00" && ld.late === "23:00", "engine credits both after both granted");
}

// ── migration backfill: old row (pre early_status) inherits status ──
{
  // Simulate a legacy row written before early_status existed: requested_from
  // set, early_status NULL, whole row approved under the old shared status.
  db.prepare(`
    INSERT INTO ot_requests (user_id, branch_id, work_date, requested_until, requested_from, status, early_status, created_at)
    VALUES (?, ?, ?, '20:00', '10:00', 'approved', NULL, ?)
  `).run(2, B, "2026-07-01", now);
  // The backfill from db.ts:
  db.exec("UPDATE ot_requests SET early_status = status WHERE requested_from IS NOT NULL AND early_status IS NULL");
  const ld = loadApproved(2, "2026-07-01");
  assert(ld.early === "10:00" && ld.late === "20:00", "backfill: legacy approved early stays credited");
}

// ── pending-digest guard: early-only pending row isn't a phantom late ──
{
  const D = "2026-08-13";
  fileEarlyStaff(U, D, "07:45");            // early pending, requested_until=''
  const latePending = db.prepare(
    "SELECT COUNT(*) AS n FROM ot_requests WHERE work_date = ? AND status = 'pending' AND requested_until != ''"
  ).get(D) as { n: number };
  assert(latePending.n === 0, "early-only pending row does NOT show as a pending late request");
  const earlyPending = db.prepare(
    "SELECT COUNT(*) AS n FROM ot_requests WHERE work_date = ? AND early_status = 'pending' AND requested_from IS NOT NULL"
  ).get(D) as { n: number };
  assert(earlyPending.n === 1, "early-only pending row DOES show as a pending early request");
}

console.log("\nOT decouple: all checks passed ✓");
