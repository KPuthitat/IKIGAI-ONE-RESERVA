import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = process.env.DATABASE_PATH || "./data/reserva.db";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  const dir = path.dirname(path.resolve(DB_PATH));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // bootstrap schema if needed
  const schemaPath = path.join(process.cwd(), "src/lib/schema.sql");
  if (fs.existsSync(schemaPath)) {
    const schema = fs.readFileSync(schemaPath, "utf8");
    db.exec(schema);
  }
  runMigrations(db);
  _db = db;
  return db;
}

// migrations เผื่อ schema เปลี่ยนทีหลัง — ทำงานทุกครั้งแบบ idempotent
function runMigrations(db: Database.Database): void {
  // bookings columns
  const bcols = db.prepare("PRAGMA table_info(bookings)").all() as Array<{ name: string }>;
  const bnames = new Set(bcols.map((c) => c.name));
  if (!bnames.has("customer_origin")) {
    db.exec("ALTER TABLE bookings ADD COLUMN customer_origin TEXT");
  }
  if (!bnames.has("is_member")) {
    db.exec("ALTER TABLE bookings ADD COLUMN is_member INTEGER");
  }
  // Customer's selected UI language at booking time — used to localize the
  // LINE Flex confirmation/reminder cards. NULL = legacy or unknown → default
  // to Thai when rendering.
  if (!bnames.has("lang")) {
    db.exec("ALTER TABLE bookings ADD COLUMN lang TEXT");
  }
  // Booking channel — distinct from the marketing 'source' column. Tells us
  // how the booking *came in* so we can split monthly stats:
  //   'online' = customer self-served via the booking form (default)
  //   'phone'  = staff entered a future booking from a phone call
  //   'walkin' = staff entered a customer who walked in just now
  //   'line'   = staff entered a booking from a direct LINE chat (not
  //              through the public form). Customer may have a line_user_id
  //              attached so the confirm Flex card can be pushed back.
  //   NULL     = legacy row from before this column existed (treat as online)
  if (!bnames.has("booking_channel")) {
    db.exec("ALTER TABLE bookings ADD COLUMN booking_channel TEXT");
  }

  // Cancellation reason — admin-supplied note shown to customer in the
  // cancel Flex card. Free text (one of the preset reasons or a custom
  // message). NULL when admin cancels without picking a reason (e.g. on
  // the customer-side edit page).
  if (!bnames.has("cancel_reason")) {
    db.exec("ALTER TABLE bookings ADD COLUMN cancel_reason TEXT");
  }

  // Food allergies / dietary restrictions — free text from the
  // customer booking form. Surfaced to staff in the admin pending +
  // detail views and in the LINE Flex card so the table survey doesn't
  // re-ask. Empty/NULL = customer didn't mention any.
  if (!bnames.has("food_allergy")) {
    db.exec("ALTER TABLE bookings ADD COLUMN food_allergy TEXT");
  }

  // Two-step booking workflow (added 2026-05-09):
  // Customer submits without picking a table → status='pending_review'.
  // Admin assigns a table + clicks "Confirm and notify" → status='confirmed'
  // and the customer Flex card is pushed at that moment. The original
  // CHECK constraint did not include 'pending_review', so we rebuild the
  // table to extend it. This is idempotent — only fires when the existing
  // CHECK is missing 'pending_review'.
  const ddl = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='bookings'"
  ).get() as { sql: string } | undefined;
  if (ddl && !/'pending_review'/.test(ddl.sql)) {
    const colInfos = db.prepare("PRAGMA table_info(bookings)").all() as Array<{ name: string }>;
    const colList = colInfos.map((c) => `"${c.name}"`).join(", ");

    // Replace the status CHECK clause with one that includes pending_review,
    // then rename the CREATE TABLE target so we can copy data into it.
    const newDdl = ddl.sql
      .replace(
        /CHECK\s*\(\s*status\s+IN\s*\([^)]+\)\s*\)/,
        "CHECK (status IN ('pending_review','confirmed','seated','no_show','cancelled','completed'))"
      )
      .replace(
        /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?bookings["`]?\b/i,
        "CREATE TABLE bookings_new"
      );

    db.exec("BEGIN");
    try {
      db.exec(newDdl);
      db.exec(`INSERT INTO bookings_new (${colList}) SELECT ${colList} FROM bookings`);
      db.exec("DROP TABLE bookings");
      db.exec("ALTER TABLE bookings_new RENAME TO bookings");
      // Indexes are dropped along with the original table — recreate them.
      db.exec("CREATE INDEX IF NOT EXISTS idx_bookings_branch_date ON bookings(branch_id, booking_date)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_bookings_table ON bookings(table_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_bookings_ref_no ON bookings(ref_no)");
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  // Public-facing booking reference: 'R' + YYYYMM + 4-digit sequence per
  // calendar month. Customers see it on the LINE Flex card; staff scan
  // the QR (which encodes this ref) to find the booking instantly.
  // Examples: R2026050001, R2026050234.
  if (!bnames.has("ref_no")) {
    db.exec("ALTER TABLE bookings ADD COLUMN ref_no TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_bookings_ref_no ON bookings(ref_no)");
    // Backfill existing rows. Sequence is deterministic via row id ordered
    // ascending within each YYYY-MM bucket — preserves history.
    db.exec(`
      WITH numbered AS (
        SELECT id, booking_date,
          ROW_NUMBER() OVER (
            PARTITION BY substr(booking_date, 1, 7)
            ORDER BY id
          ) AS seq
        FROM bookings
        WHERE ref_no IS NULL
      )
      UPDATE bookings
      SET ref_no = 'R' || substr(booking_date, 1, 4) || substr(booking_date, 6, 2)
                  || printf('%04d', (SELECT seq FROM numbered WHERE numbered.id = bookings.id))
      WHERE ref_no IS NULL;
    `);
  }

  // Zones — group tables by physical area (floor 1 / floor 2 / outdoor / VIP).
  // Per-branch. Used for grouping in the timetable view, restricting
  // availability by time-of-day (Sprint 3), and customer photo galleries
  // (Sprint 4). Tables without a zone (zone_id NULL) appear in a "ไม่ระบุโซน"
  // bucket — useful during migration of existing branches.
  db.exec(`
    CREATE TABLE IF NOT EXISTS zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      name TEXT NOT NULL,                      -- 'ชั้น 1' / 'Outdoor' / 'VIP'
      description TEXT,                        -- shown to customers later
      display_order INTEGER NOT NULL DEFAULT 100,
      active INTEGER NOT NULL DEFAULT 1,
      availability_rules TEXT,                 -- JSON, populated in Sprint 3
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (branch_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_zones_branch ON zones(branch_id);
  `);

  // tables.zone_id — links each table to a zone (nullable for legacy rows)
  const tcols = db.prepare("PRAGMA table_info(tables)").all() as Array<{ name: string }>;
  if (!tcols.some((c) => c.name === "zone_id")) {
    db.exec("ALTER TABLE tables ADD COLUMN zone_id INTEGER REFERENCES zones(id) ON DELETE SET NULL");
  }
  // แปลง source string เก่า → JSON array (idempotent)
  db.exec(`
    UPDATE bookings
    SET source = json_array(source)
    WHERE source IS NOT NULL
      AND source != ''
      AND substr(source, 1, 1) != '['
  `);

  // users.pin_hash — สำหรับ time clock 4-digit PIN
  const ucols = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!ucols.some((c) => c.name === "pin_hash")) {
    db.exec("ALTER TABLE users ADD COLUMN pin_hash TEXT");
  }

  // shift_checklist_items — admin-configurable list of checklist items
  // shown on the shift open / close handover forms. Per-branch so each
  // restaurant manages its own list (e.g. NAMA has "เครื่องชง pasta",
  // HYPOPLARAEMIA does not). Soft-deletable via active=0 so historical
  // reports keep their references readable.
  //
  // The table was originally created without branch_id. The migration
  // below adds the column, clones any pre-existing global rows once per
  // branch (so nothing is lost), and the per-branch seed below fills
  // any branch that ends up without items.
  db.exec(`
    CREATE TABLE IF NOT EXISTS shift_checklist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('shift_open','shift_close','readiness_1130','readiness_1600')),
      label TEXT NOT NULL,
      display_order INTEGER NOT NULL DEFAULT 100,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 2026-05: extend CHECK on `type` to include 'readiness_1130' and
  // 'readiness_1600' so admin can configure those checklists too.
  // Tables created before this commit have the old narrow CHECK and
  // would reject INSERTs of the new types. Idempotent — only rebuilds
  // when the existing DDL doesn't already mention the new types.
  const checklistDdl = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='shift_checklist_items'"
  ).get() as { sql: string } | undefined;
  if (checklistDdl && !/readiness_1130/.test(checklistDdl.sql)) {
    const colInfos = db.prepare("PRAGMA table_info(shift_checklist_items)").all() as Array<{ name: string }>;
    const colList = colInfos.map((c) => `"${c.name}"`).join(", ");
    const newDdl = checklistDdl.sql
      .replace(
        /CHECK\s*\(\s*type\s+IN\s*\([^)]+\)\s*\)/,
        "CHECK (type IN ('shift_open','shift_close','readiness_1130','readiness_1600'))"
      )
      .replace(
        /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?shift_checklist_items["`]?\b/i,
        "CREATE TABLE shift_checklist_items_new"
      );
    db.exec("BEGIN");
    try {
      db.exec(newDdl);
      db.exec(`INSERT INTO shift_checklist_items_new (${colList}) SELECT ${colList} FROM shift_checklist_items`);
      db.exec("DROP TABLE shift_checklist_items");
      db.exec("ALTER TABLE shift_checklist_items_new RENAME TO shift_checklist_items");
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  const sccols = db.prepare("PRAGMA table_info(shift_checklist_items)").all() as Array<{ name: string }>;
  const sccolNames = new Set(sccols.map((c) => c.name));
  if (!sccolNames.has("branch_id")) {
    db.exec("ALTER TABLE shift_checklist_items ADD COLUMN branch_id INTEGER REFERENCES branches(id)");
    // Clone any orphan (NULL branch_id) rows once per existing branch so
    // pre-migration items show up in every branch's list. Then drop the
    // originals. Safe even if there are zero orphan rows.
    type Orphan = {
      id: number; type: "shift_open" | "shift_close"; label: string;
      display_order: number; active: number;
    };
    const orphans = db.prepare(
      "SELECT id, type, label, display_order, active FROM shift_checklist_items WHERE branch_id IS NULL"
    ).all() as Orphan[];
    if (orphans.length > 0) {
      const branchIds = (db.prepare("SELECT id FROM branches").all() as Array<{ id: number }>).map((r) => r.id);
      const insClone = db.prepare(
        "INSERT INTO shift_checklist_items (type, label, display_order, active, branch_id) VALUES (?, ?, ?, ?, ?)"
      );
      for (const bid of branchIds) {
        for (const o of orphans) {
          insClone.run(o.type, o.label, o.display_order, o.active, bid);
        }
      }
      db.exec("DELETE FROM shift_checklist_items WHERE branch_id IS NULL");
    }
  }

  // Old (global) index is replaced by a branch-scoped one. DROP IF EXISTS
  // is idempotent on the upgraded shape too, so we always converge on
  // the new index.
  db.exec("DROP INDEX IF EXISTS idx_shift_checklist_type_active");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_shift_checklist_branch_type
      ON shift_checklist_items(branch_id, type, active, display_order);
  `);

  // Seed default shift_open items per branch — only fills branches that
  // currently have zero rows of this type. Idempotent across restarts;
  // also covers a freshly-added branch (gets its own copy of the list).
  const checklistDefaults = [
    "Empeo work-in",
    "ตั้งป้ายหน้าร้าน",
    "นับเงินในลิ้นชัก",
    "ตรวจสอบความสะอาดห้องน้ำ (เติมสบู่/ทิชชู่/เปลี่ยนถุงขยะ)",
    "ตรวจสอบ Battery",
    "ตรวจสอบ Booking ประจำวัน"
  ];
  const allBranches = db.prepare("SELECT id FROM branches").all() as Array<{ id: number }>;
  const seedIns = db.prepare(
    "INSERT INTO shift_checklist_items (type, label, display_order, branch_id) VALUES (?, ?, ?, ?)"
  );
  for (const b of allBranches) {
    const cnt = db.prepare(
      "SELECT COUNT(*) AS n FROM shift_checklist_items WHERE type = 'shift_open' AND branch_id = ?"
    ).get(b.id) as { n: number };
    if (cnt.n === 0) {
      for (let i = 0; i < checklistDefaults.length; i++) {
        seedIns.run("shift_open", checklistDefaults[i], (i + 1) * 10, b.id);
      }
    }
  }

  // Phase 2 (2026-05) — time_entries.branch_id + leave_requests.branch_id
  //
  // Capturing branch on every clock-in / leave-request lets admin filter
  // PERSONA pages per-branch (employees/timesheets/leave/payroll). Without
  // it, a person who works at NAMA in the morning and HYPOPLARAEMIA in
  // the afternoon would have their entire day lumped together — wrong
  // for payroll and unhelpful for the per-branch admin views.
  //
  // Migration is two-step: ADD nullable, BACKFILL from user's first
  // assigned branch (best guess for legacy rows since we don't know
  // where they actually worked). Going forward, every new write picks
  // up branch_id explicitly from the session activeBranchId.
  function ensureBranchIdColumn(table: string) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "branch_id")) return; // already migrated
    db.exec(`ALTER TABLE ${table} ADD COLUMN branch_id INTEGER REFERENCES branches(id)`);
    // Backfill orphan rows with the user's first-assigned branch (by
    // user_branches insert order). When a user has zero branches, leave
    // branch_id NULL — those rows surface as "untagged" in admin views.
    db.exec(`
      UPDATE ${table}
      SET branch_id = (
        SELECT ub.branch_id FROM user_branches ub
        WHERE ub.user_id = ${table}.user_id
        ORDER BY ub.branch_id LIMIT 1
      )
      WHERE branch_id IS NULL
    `);
  }
  ensureBranchIdColumn("time_entries");
  ensureBranchIdColumn("leave_requests");

  // Index for the most common admin query: "show all entries at this
  // branch in this date range" → composite (branch_id, ts/date_from).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_time_entries_branch_ts
      ON time_entries(branch_id, ts);
    CREATE INDEX IF NOT EXISTS idx_leave_branch_status
      ON leave_requests(branch_id, status, created_at);
  `);

  // daily_reports — PERSONA shift handover + readiness reports.
  // One row per submission; `data` is a JSON blob of the form fields
  // for that report type so we can evolve the form without ALTER
  // TABLE every time. Indexed on (branch_id, report_date) so admin
  // can pull a day's reports cheaply, and on type for filtering.
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('shift_open','shift_close','readiness_1130','readiness_1600')),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      report_date TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_daily_reports_branch_date ON daily_reports(branch_id, report_date);
    CREATE INDEX IF NOT EXISTS idx_daily_reports_type ON daily_reports(type);
  `);

  // Unique guard for shift_open: one report per (branch, date). Without
  // it, two staff could each open the same branch's shift and the LINE
  // group would receive two cards. Enforced with a partial index — only
  // shift_open rows participate; shift_close/readiness reuse the same
  // table without conflict.
  //
  // Pre-cleanup: prior to this migration, the API didn't dedupe so
  // databases that have been running a while may carry duplicate rows
  // (same branch + type + date). Creating the unique index against
  // those rows would throw SQLITE_CONSTRAINT and brick the whole
  // getDb() call (every request fails — login included). We collapse
  // dupes first by keeping only the highest-id (latest) row per
  // (branch, type, date) group and dropping the older ones, then
  // create the index. The DELETE is a no-op on clean databases.
  //
  // 2026-05: index broadened from `WHERE type = 'shift_open'` to all
  // 4 daily-report types so close + readiness reports also enforce
  // one-per-day-per-branch. The narrow shift_open index is dropped
  // first so it doesn't conflict with the broader replacement.
  // 2026-05 (later): add `superseded_at` + `replaces_id` so admin can
  // "approve edit" instead of hard-deleting the original report.
  // Granting an unlock marks the original superseded; the staff's
  // re-submit creates a new row that references the original via
  // replaces_id. Audit-trail preserved, and the unique-per-day
  // partial index switches to filter superseded_at IS NULL so only
  // the live (non-superseded) row counts toward uniqueness.
  const drCols = db.prepare("PRAGMA table_info(daily_reports)").all() as Array<{ name: string }>;
  const drColNames = new Set(drCols.map((c) => c.name));
  if (!drColNames.has("superseded_at")) {
    db.exec("ALTER TABLE daily_reports ADD COLUMN superseded_at TEXT");
  }
  if (!drColNames.has("replaces_id")) {
    db.exec("ALTER TABLE daily_reports ADD COLUMN replaces_id INTEGER REFERENCES daily_reports(id)");
  }

  // The DELETE below is a ONE-TIME dedupe cleanup that's only needed
  // before the unique index exists. Skip it once the index is in
  // place — subsequent migration runs would otherwise risk FK
  // failures: daily_reports.replaces_id self-references the same
  // table, so deleting an "older" row that has a newer revision
  // pointing at it via replaces_id throws SQLITE_CONSTRAINT_FOREIGNKEY
  // and bricks the whole getDb() (every request 500s — login too).
  //
  // The try/catch around the DELETE is the second line of defense
  // for edge cases: a corrupted database where the index is missing
  // but a revision chain exists. We log and continue; the unique
  // index creation below may still fail on dupes, but its own
  // try/catch keeps the app alive.
  const liveIndexExists = !!db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_daily_reports_live_unique'"
  ).get();
  if (!liveIndexExists) {
    try {
      db.exec(`
        DELETE FROM daily_reports
        WHERE id NOT IN (
          SELECT MAX(id) FROM daily_reports
          GROUP BY branch_id, type, report_date
        );
      `);
    } catch (e) {
      // FK chain (replaces_id) most likely cause — old rows are
      // referenced by newer revisions and can't be deleted. App-level
      // dedupe in the daily-report route still prevents new dupes;
      // operator can clean up manually if needed.
      console.warn("daily_reports dedupe DELETE skipped:", e);
    }
  }
  db.exec("DROP INDEX IF EXISTS idx_daily_reports_shift_open_unique");
  // Replace the prior broad unique index with one that filters out
  // superseded rows, so a revision can be inserted alongside the
  // original without violating uniqueness. Idempotent: DROP/CREATE
  // is safe to re-run.
  db.exec("DROP INDEX IF EXISTS idx_daily_reports_unique_per_day");
  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_reports_live_unique
        ON daily_reports(branch_id, type, report_date)
        WHERE superseded_at IS NULL;
    `);
  } catch (e) {
    // Defense-in-depth: if cleanup somehow missed a dupe (concurrent
    // write between DELETE and CREATE INDEX, etc.), don't take the
    // whole app down — log and continue. The app-level dedupe in
    // the route handler still prevents new dupes; admin can clean
    // the residue manually and a future restart will pick up the
    // index.
    console.warn("daily_reports live unique index creation skipped:", e);
  }

  // shift_unlock_requests — staff asks admin to let them re-submit a
  // shift_open they already filed (e.g. typo on the morning drawer
  // amount). Notification to the LINE staff group is sent at create
  // time; admin grants by deleting the daily_reports row (Phase 1)
  // or via a future admin UI (Phase 2). Status flips to 'granted'
  // when admin acts, 'pending' otherwise.
  db.exec(`
    CREATE TABLE IF NOT EXISTS shift_unlock_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      daily_report_id INTEGER NOT NULL REFERENCES daily_reports(id) ON DELETE CASCADE,
      requested_by INTEGER NOT NULL REFERENCES users(id),
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','granted','rejected')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      decided_by INTEGER REFERENCES users(id),
      decided_at TEXT,
      decision_note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_shift_unlock_status ON shift_unlock_requests(status, created_at);
  `);

  // persona_activity_log — lightweight audit trail of who did what
  // (no details). Keeps the table small + cheap: just user_id +
  // action string + optional ref_id pointing at the affected row +
  // timestamp. Reads stay rare (admin opens an audit screen), so we
  // don't over-index.
  db.exec(`
    CREATE TABLE IF NOT EXISTS persona_activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      action TEXT NOT NULL,
      ref_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_persona_activity_user_created
      ON persona_activity_log(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_persona_activity_action_created
      ON persona_activity_log(action, created_at);
  `);

  // 2026-05: decision_note added so admin can explain a rejection
  // (the staff sees this on the locked view + LINE notification).
  // Idempotent — only adds the column if missing.
  const surcols = db.prepare("PRAGMA table_info(shift_unlock_requests)").all() as Array<{ name: string }>;
  if (!surcols.some((c) => c.name === "decision_note")) {
    db.exec("ALTER TABLE shift_unlock_requests ADD COLUMN decision_note TEXT");
  }

  // time_entries_audit — เผื่อกรณี schema.sql ยังไม่ถูกรันบน server เก่า
  db.exec(`
    CREATE TABLE IF NOT EXISTS time_entries_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER,
      entry_user_id INTEGER NOT NULL,
      entry_type TEXT NOT NULL,
      entry_ts TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('delete','edit','create')),
      admin_id INTEGER NOT NULL REFERENCES users(id),
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_time_audit_created ON time_entries_audit(created_at);
  `);

  // Normalize timestamps → ISO with milliseconds (matches new Date().toISOString())
  // SQLite CURRENT_TIMESTAMP returns "YYYY-MM-DD HH:MM:SS" (UTC, no marker)
  // → JS Date parses as LOCAL time = off by N hours if server TZ != UTC
  // Fix once: convert all existing rows to ISO. New inserts use new Date().toISOString().
  // Format: "2026-05-05T17:09:00.000Z" (24 chars) — string-comparable with new inserts
  db.exec(`
    UPDATE time_entries
    SET ts = REPLACE(ts, ' ', 'T') || '.000Z'
    WHERE ts NOT LIKE '%T%' AND length(ts) = 19;
  `);
  db.exec(`
    UPDATE time_entries_audit
    SET entry_ts = REPLACE(entry_ts, ' ', 'T') || '.000Z'
    WHERE entry_ts NOT LIKE '%T%' AND length(entry_ts) = 19;
  `);
  db.exec(`
    UPDATE time_entries_audit
    SET created_at = REPLACE(created_at, ' ', 'T') || '.000Z'
    WHERE created_at NOT LIKE '%T%' AND length(created_at) = 19;
  `);

  // leave_requests — เผื่อกรณี schema.sql ยังไม่ถูกรันบน server เก่า
  db.exec(`
    CREATE TABLE IF NOT EXISTS leave_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      days REAL NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
        ('pending','approved','rejected','cancelled')),
      decided_by INTEGER REFERENCES users(id),
      decided_at TEXT,
      decision_note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_leave_user_status ON leave_requests(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_leave_status_created ON leave_requests(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_leave_dates ON leave_requests(date_from, date_to);
  `);

  // Phase 1C v2 migrations — extend users + leave_requests
  const ucols2 = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  const unames = new Set(ucols2.map((c) => c.name));
  if (!unames.has("gender")) db.exec("ALTER TABLE users ADD COLUMN gender TEXT"); // 'male'|'female'|null
  if (!unames.has("employment_type")) db.exec("ALTER TABLE users ADD COLUMN employment_type TEXT"); // 'pt'|'ft'|null

  const lrcols = db.prepare("PRAGMA table_info(leave_requests)").all() as Array<{ name: string }>;
  const lnames = new Set(lrcols.map((c) => c.name));
  if (!lnames.has("hours")) db.exec("ALTER TABLE leave_requests ADD COLUMN hours REAL"); // null = full day(s)
  if (!lnames.has("evidence_filename")) db.exec("ALTER TABLE leave_requests ADD COLUMN evidence_filename TEXT");
  if (!lnames.has("created_by")) db.exec("ALTER TABLE leave_requests ADD COLUMN created_by INTEGER REFERENCES users(id)");
  // Phase 1C v4: special-track flag (ต้องอนุมัติพิเศษโดยผู้บริหาร)
  if (!lnames.has("is_special_request")) db.exec("ALTER TABLE leave_requests ADD COLUMN is_special_request INTEGER NOT NULL DEFAULT 0");
  // Phase 1C v9: replaces_id — ลิงก์คำขอใหม่ที่แก้แล้วกลับไปยังคำขอเดิม
  if (!lnames.has("replaces_id")) db.exec("ALTER TABLE leave_requests ADD COLUMN replaces_id INTEGER");

  // leave_types catalog (กฎเกณฑ์การลา)
  db.exec(`
    CREATE TABLE IF NOT EXISTS leave_types (
      code TEXT PRIMARY KEY,
      default_quota_days REAL,
      gender_eligibility TEXT NOT NULL DEFAULT 'all' CHECK (gender_eligibility IN ('all','male','female')),
      employment_eligibility TEXT NOT NULL DEFAULT 'all' CHECK (employment_eligibility IN ('all','pt','ft')),
      requires_pre_approval INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);
  // Phase 1C v4: เพิ่มคอลัมน์ requires_evidence (DEFAULT 1 — ต้องแนบหลักฐาน)
  const ltcols = db.prepare("PRAGMA table_info(leave_types)").all() as Array<{ name: string }>;
  if (!ltcols.some((c) => c.name === "requires_evidence")) {
    db.exec("ALTER TABLE leave_types ADD COLUMN requires_evidence INTEGER NOT NULL DEFAULT 1");
  }

  // seed/update — idempotent (รวมการลบ pilgrimage)
  db.prepare("DELETE FROM leave_types WHERE code = 'pilgrimage'").run();
  const seedLeaveType = db.prepare(`
    INSERT INTO leave_types (code, default_quota_days, gender_eligibility, employment_eligibility, requires_pre_approval, requires_evidence, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      default_quota_days = excluded.default_quota_days,
      gender_eligibility = excluded.gender_eligibility,
      employment_eligibility = excluded.employment_eligibility,
      requires_pre_approval = excluded.requires_pre_approval,
      requires_evidence = excluded.requires_evidence,
      sort_order = excluded.sort_order
  `);
  // [code, quota_days, gender, employment, pre_approval, requires_evidence, sort]
  const types: Array<[string, number | null, string, string, number, number, number]> = [
    ["sick",          30,   "all",    "all", 0, 1, 1],   // ต้องแนบหลักฐานเสมอ
    ["personal",      3,    "all",    "all", 0, 0, 2],   // ไม่บังคับแนบ
    ["annual",        6,    "all",    "all", 0, 0, 3],   // ไม่บังคับแนบ
    ["pt_emergency",  null, "all",    "pt",  0, 1, 4],
    ["maternity",     98,   "female", "all", 1, 1, 5],
    ["sterilization", null, "all",    "all", 1, 1, 6],
    ["ordination",    90,   "male",   "all", 0, 1, 7],
    ["military",      60,   "male",   "all", 0, 1, 8]
  ];
  for (const t of types) seedLeaveType.run(...t);

  // user_leave_quotas — admin override quota รายคน (Phase 1C v4)
  // ถ้าไม่มี row → ใช้ default จาก leave_types
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_leave_quotas (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      quota_days REAL NOT NULL,
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, type)
    );
  `);

  // leave_unlocks — admin pre-approves ก่อนพนักงานขอลาประเภทพิเศษ (maternity, sterilization)
  db.exec(`
    CREATE TABLE IF NOT EXISTS leave_unlocks (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      unlocked_by INTEGER NOT NULL REFERENCES users(id),
      unlocked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      evidence_filename TEXT,
      expected_date TEXT,
      notes TEXT,
      PRIMARY KEY (user_id, type)
    );
  `);

  // Phase 1C v3: hire_date + public_holidays
  if (!unames.has("hire_date")) db.exec("ALTER TABLE users ADD COLUMN hire_date TEXT");
  // Phase 1C v5: weekly_off_day (0=Sun, 1=Mon, ..., 6=Sat, NULL=ยังไม่ตั้ง)
  // (deprecated — kept for backward compat; readers should use weekly_off_days)
  if (!unames.has("weekly_off_day")) db.exec("ALTER TABLE users ADD COLUMN weekly_off_day INTEGER");
  // Phase C v6: weekly_off_days (CSV of digits, e.g. "1,2" = Mon+Tue) — supports multi-day
  if (!unames.has("weekly_off_days")) {
    db.exec("ALTER TABLE users ADD COLUMN weekly_off_days TEXT");
    // Migrate legacy single-day value into the new CSV column
    db.exec(`
      UPDATE users
      SET weekly_off_days = CAST(weekly_off_day AS TEXT)
      WHERE weekly_off_day IS NOT NULL AND weekly_off_days IS NULL
    `);
  }
  // Phase C v7: per-staff LINE userId (for sending Flex messages on clock-in etc.)
  // Bound manually by admin in the employees edit modal — admin gets the userId
  // from LINE OA dashboard or from the webhook log when staff messages the OA.
  if (!unames.has("line_user_id")) db.exec("ALTER TABLE users ADD COLUMN line_user_id TEXT");
  // Phase 1C v6: resignation unlock (admin เปิดสิทธิ์ให้ staff ส่งคำขอลาออก)
  if (!unames.has("resignation_unlocked_at")) db.exec("ALTER TABLE users ADD COLUMN resignation_unlocked_at TEXT");
  if (!unames.has("resignation_unlocked_by")) db.exec("ALTER TABLE users ADD COLUMN resignation_unlocked_by INTEGER REFERENCES users(id)");
  // TC-5: expected shift start time per user (HH:MM, Bangkok local).
  // Used by the late-detection helper — clock-in time later than this
  // (+ grace period) flags the entry as late. NULL means we can't
  // compute lateness for this staff member; the monthly view shows
  // their entries without a late count.
  if (!unames.has("shift_start_time")) {
    db.exec("ALTER TABLE users ADD COLUMN shift_start_time TEXT");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS public_holidays (
      date TEXT PRIMARY KEY,
      name_th TEXT NOT NULL,
      name_en TEXT NOT NULL
    );
  `);
  // Phase 1C v7: is_workday flag — สำหรับวันหยุดที่ธุรกิจถือเป็นวันทำงานปกติ
  // (เช่น วันแรงงาน — ร้านอาหารยังเปิด ให้พนักงานหยุดวันอื่นทดแทน)
  const phcols = db.prepare("PRAGMA table_info(public_holidays)").all() as Array<{ name: string }>;
  if (!phcols.some((c) => c.name === "is_workday")) {
    db.exec("ALTER TABLE public_holidays ADD COLUMN is_workday INTEGER NOT NULL DEFAULT 0");
  }
  // Seed Thai public holidays — ON CONFLICT DO NOTHING เพื่อไม่ทับค่าที่แอดมินแก้
  // วันลูนาร์เป็นค่าประมาณ — แอดมินปรับผ่าน /admin/persona/holidays ได้
  const seedHoliday = db.prepare(`
    INSERT INTO public_holidays (date, name_th, name_en) VALUES (?, ?, ?)
    ON CONFLICT(date) DO NOTHING
  `);

  // วันหยุดตามวันที่คงที่ (ไม่ใช้ลูนาร์)
  const FIXED: Array<[number, number, string, string]> = [
    [1, 1,  "วันขึ้นปีใหม่", "New Year's Day"],
    [4, 6,  "วันจักรี", "Chakri Memorial Day"],
    [4, 13, "วันสงกรานต์", "Songkran Day"],
    [4, 14, "วันสงกรานต์", "Songkran Day"],
    [4, 15, "วันสงกรานต์", "Songkran Day"],
    [5, 1,  "วันแรงงานแห่งชาติ", "National Labour Day"],
    [5, 4,  "วันฉัตรมงคล", "Coronation Day"],
    [6, 3,  "วันเฉลิมพระชนมพรรษาสมเด็จพระบรมราชินี", "Queen's Birthday"],
    [7, 28, "วันเฉลิมพระชนมพรรษา ร.10", "King's Birthday"],
    [8, 12, "วันเฉลิมพระชนมพรรษาสมเด็จพระบรมราชชนนีพันปีหลวง / วันแม่", "Mother's Day"],
    [10, 13, "วันคล้ายวันสวรรคต ร.9", "King Bhumibol Memorial Day"],
    [10, 23, "วันปิยมหาราช", "Chulalongkorn Day"],
    [12, 5,  "วันคล้ายวันพระบรมราชสมภพ ร.9 / วันชาติ", "King Bhumibol's Birthday / National Day"],
    [12, 10, "วันรัฐธรรมนูญ", "Constitution Day"],
    [12, 31, "วันสิ้นปี", "New Year's Eve"]
  ];

  // วันลูนาร์ — ระบุปีต่อปี (ค่าประมาณตามปฏิทินจันทรคติ — แอดมินแก้ได้)
  // วันมาฆบูชา / วิสาขบูชา / อาสาฬหบูชา + เข้าพรรษา (อาสาฬหบูชา + 1)
  const LUNAR: Record<string, Array<[string, string, string]>> = {
    "2026": [
      ["2026-03-03", "วันมาฆบูชา", "Makha Bucha Day"],
      ["2026-05-31", "วันวิสาขบูชา", "Visakha Bucha Day"],
      ["2026-07-30", "วันอาสาฬหบูชา", "Asalha Bucha Day"],
      ["2026-07-31", "วันเข้าพรรษา", "Buddhist Lent Day"]
    ],
    "2027": [
      ["2027-02-21", "วันมาฆบูชา", "Makha Bucha Day"],
      ["2027-05-20", "วันวิสาขบูชา", "Visakha Bucha Day"],
      ["2027-07-18", "วันอาสาฬหบูชา", "Asalha Bucha Day"],
      ["2027-07-19", "วันเข้าพรรษา", "Buddhist Lent Day"]
    ],
    "2028": [
      ["2028-02-10", "วันมาฆบูชา", "Makha Bucha Day"],
      ["2028-05-08", "วันวิสาขบูชา", "Visakha Bucha Day"],
      ["2028-07-06", "วันอาสาฬหบูชา", "Asalha Bucha Day"],
      ["2028-07-07", "วันเข้าพรรษา", "Buddhist Lent Day"]
    ],
    "2029": [
      ["2029-02-28", "วันมาฆบูชา", "Makha Bucha Day"],
      ["2029-05-27", "วันวิสาขบูชา", "Visakha Bucha Day"],
      ["2029-07-25", "วันอาสาฬหบูชา", "Asalha Bucha Day"],
      ["2029-07-26", "วันเข้าพรรษา", "Buddhist Lent Day"]
    ],
    "2030": [
      ["2030-02-17", "วันมาฆบูชา", "Makha Bucha Day"],
      ["2030-05-16", "วันวิสาขบูชา", "Visakha Bucha Day"],
      ["2030-07-14", "วันอาสาฬหบูชา", "Asalha Bucha Day"],
      ["2030-07-15", "วันเข้าพรรษา", "Buddhist Lent Day"]
    ]
  };

  // Seed 5 years (2026-2030)
  for (let year = 2026; year <= 2030; year++) {
    const yStr = String(year);
    for (const [mm, dd, th, en] of FIXED) {
      const date = `${yStr}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
      seedHoliday.run(date, th, en);
    }
    for (const [date, th, en] of LUNAR[yStr] || []) {
      seedHoliday.run(date, th, en);
    }
  }

  // Phase 1C v7: migrate CHECK constraints to include 'revision_requested'
  // SQLite ไม่อนุญาต ALTER CHECK → ต้อง recreate table
  const lrSql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='leave_requests'"
  ).get() as { sql: string } | undefined;
  if (lrSql && !lrSql.sql.includes("'revision_requested'")) {
    db.exec(`
      BEGIN;
      CREATE TABLE leave_requests_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        date_from TEXT NOT NULL,
        date_to TEXT NOT NULL,
        days REAL NOT NULL,
        hours REAL,
        reason TEXT,
        evidence_filename TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
          ('pending','approved','rejected','cancelled','revision_requested')),
        decided_by INTEGER REFERENCES users(id),
        decided_at TEXT,
        decision_note TEXT,
        created_by INTEGER REFERENCES users(id),
        is_special_request INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO leave_requests_new
        (id, user_id, type, date_from, date_to, days, hours, reason,
         evidence_filename, status, decided_by, decided_at, decision_note,
         created_by, is_special_request, created_at)
      SELECT id, user_id, type, date_from, date_to, days, hours, reason,
             evidence_filename, status, decided_by, decided_at, decision_note,
             created_by, COALESCE(is_special_request, 0), created_at
      FROM leave_requests;
      DROP TABLE leave_requests;
      ALTER TABLE leave_requests_new RENAME TO leave_requests;
      CREATE INDEX IF NOT EXISTS idx_leave_user_status ON leave_requests(user_id, status);
      CREATE INDEX IF NOT EXISTS idx_leave_status_created ON leave_requests(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_leave_dates ON leave_requests(date_from, date_to);
      COMMIT;
    `);
  }

  // Phase 1C v5: resignation_requests
  db.exec(`
    CREATE TABLE IF NOT EXISTS resignation_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      proposed_last_day TEXT NOT NULL,
      computed_min_last_day TEXT NOT NULL,
      reason TEXT NOT NULL,
      evidence_filename TEXT,
      is_special_request INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected','cancelled','revision_requested')),
      decided_by INTEGER REFERENCES users(id),
      decided_at TEXT,
      decision_note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_resignation_user ON resignation_requests(user_id);
    CREATE INDEX IF NOT EXISTS idx_resignation_status ON resignation_requests(status, created_at);
  `);

  // RESERVA: branch status / opening date / weekly closed days
  const bcols2 = db.prepare("PRAGMA table_info(branches)").all() as Array<{ name: string }>;
  const bnames2 = new Set(bcols2.map((c) => c.name));
  if (!bnames2.has("status")) {
    db.exec("ALTER TABLE branches ADD COLUMN status TEXT NOT NULL DEFAULT 'open'");
  }
  if (!bnames2.has("opens_on")) {
    db.exec("ALTER TABLE branches ADD COLUMN opens_on TEXT");
  }
  if (!bnames2.has("closed_weekdays")) {
    db.exec("ALTER TABLE branches ADD COLUMN closed_weekdays TEXT"); // JSON array '[1,2]'
  }
  // RESERVA: lunch break (พักกลางวัน) — applies on lunch_break_weekdays
  if (!bnames2.has("lunch_break_start")) {
    db.exec("ALTER TABLE branches ADD COLUMN lunch_break_start TEXT"); // 'HH:MM'
  }
  if (!bnames2.has("lunch_break_end")) {
    db.exec("ALTER TABLE branches ADD COLUMN lunch_break_end TEXT");
  }
  if (!bnames2.has("lunch_break_weekdays")) {
    db.exec("ALTER TABLE branches ADD COLUMN lunch_break_weekdays TEXT"); // '[1,2,3,4,5]' = Mon-Fri
  }
  // วันพิเศษที่เปิดเต็มวัน (override lunch break) เช่น วันธรรมดาที่จัดงานพิเศษ
  if (!bnames2.has("no_lunch_break_dates")) {
    db.exec("ALTER TABLE branches ADD COLUMN no_lunch_break_dates TEXT"); // '["2026-12-31"]'
  }
  // Display order — lower number = appears first in lists. NAMA is the
  // company flagship and should always come first; everything else falls
  // back to alphabetical via the secondary ORDER BY name.
  if (!bnames2.has("display_order")) {
    db.exec("ALTER TABLE branches ADD COLUMN display_order INTEGER NOT NULL DEFAULT 100");
    db.exec("UPDATE branches SET display_order = 1 WHERE slug = 'nama-sriracha'");
  }
  // Optional second CTA on the customer LINE Flex card. Branch admin can
  // set a label + URL for things like 'เมนูอาหาร' (Google Drive PDF) or
  // 'ทาง Google Maps'. Both must be set for the button to render.
  if (!bnames2.has("extra_button_label")) {
    db.exec("ALTER TABLE branches ADD COLUMN extra_button_label TEXT");
  }
  if (!bnames2.has("extra_button_url")) {
    db.exec("ALTER TABLE branches ADD COLUMN extra_button_url TEXT");
  }
  // Fallback contact phone — shown to the customer in the "request received,
  // awaiting confirmation" LINE message so they have a way to follow up if
  // admin doesn't get to their pending booking. Optional; if unset the
  // pending message just omits the phone line.
  if (!bnames2.has("contact_phone")) {
    db.exec("ALTER TABLE branches ADD COLUMN contact_phone TEXT");
  }
  // LINE group ID for staff notifications — when set, notifyStaff()
  // pushes to this single group instead of looping over staff_line_user_ids.
  // Format: 'C' followed by ~32 hex chars (LINE's group ID format).
  // Captured by the webhook on a `join` event when admin invites the OA
  // into the group; the bot replies with the ID so admin can copy it
  // into /admin/reserva/settings. Cheaper too — 1 push reaches all
  // group members instead of N pushes for N staff.
  if (!bnames2.has("staff_group_id")) {
    db.exec("ALTER TABLE branches ADD COLUMN staff_group_id TEXT");
  }
  // PERSONA readiness round times — per-branch HH:MM. Used in the
  // readiness LINE Flex card title and (eventually) for scheduling
  // reminders. Default 11:30 / 16:00 mirrors the original hardcoded
  // round names so a fresh upgrade keeps the same display. Admin can
  // edit per branch at /admin/persona/settings.
  if (!bnames2.has("readiness_morning_time")) {
    db.exec("ALTER TABLE branches ADD COLUMN readiness_morning_time TEXT NOT NULL DEFAULT '11:30'");
  }
  if (!bnames2.has("readiness_afternoon_time")) {
    db.exec("ALTER TABLE branches ADD COLUMN readiness_afternoon_time TEXT NOT NULL DEFAULT '16:00'");
  }
  // Per-branch brand colour — hex string (e.g. '#e94560') used as the
  // Flex card header background. NULL = use the default IKIGAI ink colour.
  // Lets each branch reflect their own CI in the LINE notifications.
  if (!bnames2.has("brand_color")) {
    db.exec("ALTER TABLE branches ADD COLUMN brand_color TEXT");
  }

  // PERSONA Time Clock anti-cheat: GPS geofence + QR code verification.
  // Both are independently toggleable so admin can phase them in
  // without breaking clock-in for staff before the staff UI ships
  // location/QR capture. When both disabled the clock-in API skips
  // the corresponding validation entirely (current legacy behaviour).
  //
  //   - latitude/longitude:        centre of allowed clock-in area
  //   - geofence_radius_meters:    max distance from centre (default 100m)
  //   - geofence_enabled:          0/1, gates the lat/lng check
  //   - clock_qr_token:            opaque random string admin generates,
  //                                printed as a QR poster in the shop
  //   - clock_qr_enabled:          0/1, gates the QR check
  if (!bnames2.has("latitude")) {
    db.exec("ALTER TABLE branches ADD COLUMN latitude REAL");
  }
  if (!bnames2.has("longitude")) {
    db.exec("ALTER TABLE branches ADD COLUMN longitude REAL");
  }
  if (!bnames2.has("geofence_radius_meters")) {
    db.exec("ALTER TABLE branches ADD COLUMN geofence_radius_meters INTEGER NOT NULL DEFAULT 100");
  }
  if (!bnames2.has("geofence_enabled")) {
    db.exec("ALTER TABLE branches ADD COLUMN geofence_enabled INTEGER NOT NULL DEFAULT 0");
  }
  if (!bnames2.has("clock_qr_token")) {
    db.exec("ALTER TABLE branches ADD COLUMN clock_qr_token TEXT");
  }
  if (!bnames2.has("clock_qr_enabled")) {
    db.exec("ALTER TABLE branches ADD COLUMN clock_qr_enabled INTEGER NOT NULL DEFAULT 0");
  }

  // Daily attendance summary (TC-6) — per-branch HH:MM time at which
  // the cron job posts a 4-category roll-call to the executive group:
  //   • มาตรงเวลา (on time, within 5-min grace)
  //   • มาสาย (late, >5 min past their personal shift_start)
  //   • ลางาน (approved leave covers today)
  //   • ขาดงาน (no clock-in, no approved leave)
  // attendance_summary_last_sent_date is the dedupe key — once the
  // cron sends today's summary, the date is recorded so subsequent
  // cron ticks the same day are no-ops.
  //   NULL summary_time = feature disabled for that branch.
  //   Recommended value = branch open_time + 1 hour.
  if (!bnames2.has("attendance_summary_time")) {
    db.exec("ALTER TABLE branches ADD COLUMN attendance_summary_time TEXT");
  }
  if (!bnames2.has("attendance_summary_last_sent_date")) {
    db.exec("ALTER TABLE branches ADD COLUMN attendance_summary_last_sent_date TEXT");
  }

  // TC-4: time certification requests. Staff can't edit a clock
  // entry once the 5-min self-correction window closes — instead
  // they file a certification request here, admin reviews, on
  // approval we UPDATE the time_entries row + log to
  // time_entries_audit (so the legacy audit chain stays intact).
  db.exec(`
    CREATE TABLE IF NOT EXISTS time_certifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
      requested_by INTEGER NOT NULL REFERENCES users(id),
      reason TEXT NOT NULL,
      proposed_ts TEXT NOT NULL,
      original_ts TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected')),
      decided_by INTEGER REFERENCES users(id),
      decided_at TEXT,
      decision_note TEXT,
      created_at TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_time_cert_pending_branch
    ON time_certifications(status, entry_id)
    WHERE status = 'pending';
  `);

  // SVC — daily service-charge pot logged per branch per day.
  //
  // Source: admin or the closing-shift staff enters today's POS-collected
  // service-charge amount. The shift_close form will surface a field
  // that POSTs into this table, so the typical entry path is the
  // closing-shift checklist (not a separate admin task).
  //
  // Distribution rules live in src/lib/service-charge.ts:
  //   • split into 5 parts → 3 to staff pool, 2 to company
  //   • staff pool divided proportionally to each staff's hours that day
  //   • monthly view applies the 20%-late forfeiture from late-detection
  //
  // UNIQUE(branch_id, date) — exactly one row per branch per day.
  // entered_by_user_id captures the original submitter (for fraud
  // accountability) while updated_by_user_id + updated_at record the
  // last admin correction. All writes also land in persona_activity_log
  // with action='svc.daily.create'/'svc.daily.update' for the audit
  // trail the user explicitly asked for.
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_service_charge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      amount_baht REAL NOT NULL,
      entered_by_user_id INTEGER NOT NULL REFERENCES users(id),
      entered_at TEXT NOT NULL,
      updated_by_user_id INTEGER REFERENCES users(id),
      updated_at TEXT,
      daily_report_id INTEGER REFERENCES daily_reports(id) ON DELETE SET NULL,
      UNIQUE(branch_id, date)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_daily_svc_branch_date
    ON daily_service_charge(branch_id, date);
  `);

  // ── Roster (TC-R, 2026-05) ─────────────────────────────────────
  //
  // Three tables that together support "supervisor assigns monthly
  // shifts to each staff" — replaces the legacy Google Sheet flow.
  //
  //   shift_codes        — branch-scoped, flexible. Supervisor names
  //                        a shift ("NPF") and sets start/end + break
  //                        + a colour for the grid. Drives late-
  //                        detection (an assigned shift's start_time
  //                        overrides users.shift_start_time on that
  //                        date) and the staff calendar display.
  //
  //   roster_positions   — branch-scoped duty positions (CHECKER,
  //                        SAUTE, ...). Each has a title + free-text
  //                        description so staff can read their scope
  //                        of work in the calendar.
  //
  //   roster_assignments — the actual (date × position) cells. One
  //                        row per assigned slot. UNIQUE on
  //                        (branch, date, position) so a position
  //                        only has one occupant per day; a single
  //                        staff can occupy multiple positions in
  //                        a day (allowed per owner spec).
  //
  //   roster_publish_log — every "publish" or post-publish edit
  //                        bumps a row here. Drives LINE notifications
  //                        + supplies the "last published at" stamp
  //                        the calendar UI shows staff.
  db.exec(`
    CREATE TABLE IF NOT EXISTS shift_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      name TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      break_start TEXT,
      break_end TEXT,
      color TEXT,
      display_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_shift_codes_branch_code
      ON shift_codes(branch_id, code);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS roster_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      display_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_roster_positions_branch
      ON roster_positions(branch_id, active, display_order);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS roster_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      assignment_date TEXT NOT NULL,
      position_id INTEGER NOT NULL REFERENCES roster_positions(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      shift_code_id INTEGER NOT NULL REFERENCES shift_codes(id) ON DELETE RESTRICT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_roster_assign_uniq
      ON roster_assignments(branch_id, assignment_date, position_id);
    CREATE INDEX IF NOT EXISTS idx_roster_assign_user_date
      ON roster_assignments(user_id, assignment_date);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS roster_publish_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      year_month TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('publish','edit')),
      note TEXT,
      published_by INTEGER REFERENCES users(id),
      published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_roster_publish_branch_month
      ON roster_publish_log(branch_id, year_month, published_at);
  `);

  // Seed default shift codes + positions per branch on first migration.
  // Mirrors the spreadsheet the owner currently uses (NAMA roster) so
  // there's no blank-slate phase. Idempotent — only seeds when the
  // branch has zero rows in the relevant table.
  const branchesForSeed = db.prepare("SELECT id FROM branches").all() as Array<{ id: number }>;
  for (const b of branchesForSeed) {
    const shiftCount = (db.prepare(
      "SELECT COUNT(*) AS n FROM shift_codes WHERE branch_id = ?"
    ).get(b.id) as { n: number }).n;
    if (shiftCount === 0) {
      const ins = db.prepare(`
        INSERT INTO shift_codes (branch_id, code, name, start_time, end_time, break_start, break_end, color, display_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      ins.run(b.id, "NPF",   null, "11:00", "21:00", "14:00", "16:00", "#fecdd3", 1);
      ins.run(b.id, "FD-11", null, "11:00", "20:00", "15:00", "16:00", "#fef9c3", 2);
      ins.run(b.id, "FD-12", null, "12:00", "21:00", "16:00", "17:00", "#fed7aa", 3);
      ins.run(b.id, "NPN",   null, "16:00", "21:00", null,    null,    "#bfdbfe", 4);
    }
    const posCount = (db.prepare(
      "SELECT COUNT(*) AS n FROM roster_positions WHERE branch_id = ?"
    ).get(b.id) as { n: number }).n;
    if (posCount === 0) {
      const ins = db.prepare(`
        INSERT INTO roster_positions (branch_id, title, description, display_order)
        VALUES (?, ?, ?, ?)
      `);
      ins.run(b.id, "CHIEF", "ดูแลภาพรวมร้านทั้งหมด เป็นกำลังเสริมในตำแหน่งที่ขาด", 1);
      ins.run(b.id, "SERVICE", "รับออเดอร์ เสิร์ฟอาหาร เสิร์ฟน้ำ ดูแลความสะอาดโต๊ะ", 2);
      ins.run(b.id, "COLD KC.", "ดูแลอาหารที่ต้องทำในครัวเย็นทั้งหมด คอยเช็คสต็อกทุก", 3);
      ins.run(b.id, "PASTA", "ดูแลและผลิตเส้นตามที่ได้รับมอบหมายรวมไปถึงดูแลความ", 4);
      ins.run(b.id, "CHECKER", "ตรวจสอบคุณภาพอาหารก่อนเสิร์ฟ", 5);
      ins.run(b.id, "SAUTE", "ผัด/ทอดเมนูตามออเดอร์", 6);
      ins.run(b.id, "FRYING", "ทอดอาหารตามออเดอร์", 7);
      ins.run(b.id, "WASHING", "ล้างจาน ดูแลความสะอาดส่วนหลัง", 8);
    }
  }

  // forfeit_svc — set when admin approves a resignation_request and
  // decides the resigning staff loses their service-charge accrual
  // for that month (e.g. "ลาออกผิดกติกา"). The monthly SVC engine
  // checks this flag to forfeit the user's whole-month allocation
  // to the company side. Default 0 (preserved → staff still gets SVC).
  const rrcolsForSvc = db.prepare("PRAGMA table_info(resignation_requests)").all() as Array<{ name: string }>;
  if (!rrcolsForSvc.some((c) => c.name === "forfeit_svc")) {
    db.exec("ALTER TABLE resignation_requests ADD COLUMN forfeit_svc INTEGER NOT NULL DEFAULT 0");
  }

  // system_settings — singleton table for global configuration that
  // isn't branch-scoped. Today this holds the IKIGAI OS LINE OA push
  // credentials + the cross-branch staff group ID, used to route
  // PERSONA notifications (daily reports, edit requests, decisions)
  // to a single shared group where staff from every branch can see
  // them. Bookings stay on the per-branch OA (see notifyStaff).
  //
  // Singleton enforced by CHECK(id = 1). The INSERT OR IGNORE seeds
  // the row on first migration so callers can always SELECT * WHERE
  // id = 1 without a NULL row check.
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      global_line_channel_token TEXT,
      global_staff_group_id TEXT,
      updated_at TEXT,
      updated_by INTEGER
    );
  `);
  db.exec(`INSERT OR IGNORE INTO system_settings (id) VALUES (1);`);

  // Phase 1C v9: replaces_id for resignation_requests
  const rrcols = db.prepare("PRAGMA table_info(resignation_requests)").all() as Array<{ name: string }>;
  if (!rrcols.some((c) => c.name === "replaces_id")) {
    db.exec("ALTER TABLE resignation_requests ADD COLUMN replaces_id INTEGER");
  }

  // Phase 1C v10: ref_no — เลขอ้างอิง [Prefix]YYYYMM + 2-digit seq ต่อเดือน
  // Leave = "L", Resignation = "R"
  if (!lnames.has("ref_no")) db.exec("ALTER TABLE leave_requests ADD COLUMN ref_no TEXT");
  if (!rrcols.some((c) => c.name === "ref_no")) {
    db.exec("ALTER TABLE resignation_requests ADD COLUMN ref_no TEXT");
  }
  // Backfill — รองรับทั้ง NULL (fresh upgrade) และ legacy format (YYYYMMDD##)
  function backfillRefNo(
    table: "leave_requests" | "resignation_requests",
    prefix: "L" | "R",
    indexName: string
  ): void {
    // detect: any row missing ref_no OR not matching prefix → re-seq ทั้งหมด
    const needs = (db.prepare(
      `SELECT COUNT(*) AS n FROM ${table}
       WHERE ref_no IS NULL OR substr(ref_no, 1, 1) != ?`
    ).get(prefix) as { n: number }).n;
    if (needs === 0) return;

    // drop unique index ก่อน (เพราะจะ rewrite ค่าทั้งหมด อาจชนกันชั่วคราว)
    db.exec(`DROP INDEX IF EXISTS ${indexName}`);
    db.prepare(`UPDATE ${table} SET ref_no = NULL`).run();

    const rows = db.prepare(
      `SELECT id, created_at FROM ${table} ORDER BY created_at, id`
    ).all() as Array<{ id: number; created_at: string }>;
    const monthlySeq: Record<string, number> = {};
    const upd = db.prepare(`UPDATE ${table} SET ref_no = ? WHERE id = ?`);
    for (const r of rows) {
      const ts = new Date(r.created_at).getTime();
      // Bangkok YYYYMM
      const bkkMonth = new Date(ts + 7 * 60 * 60 * 1000).toISOString().slice(0, 7).replace("-", "");
      monthlySeq[bkkMonth] = (monthlySeq[bkkMonth] || 0) + 1;
      const seq = String(monthlySeq[bkkMonth]).padStart(2, "0");
      upd.run(`${prefix}${bkkMonth}${seq}`, r.id);
    }
  }
  backfillRefNo("leave_requests", "L", "idx_leave_ref_no");
  backfillRefNo("resignation_requests", "R", "idx_resignation_ref_no");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_leave_ref_no ON leave_requests(ref_no)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_resignation_ref_no ON resignation_requests(ref_no)");

  // Phase 1C v7: same migration for resignation_requests
  const rrSql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='resignation_requests'"
  ).get() as { sql: string } | undefined;
  if (rrSql && !rrSql.sql.includes("'revision_requested'")) {
    db.exec(`
      BEGIN;
      CREATE TABLE resignation_requests_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        proposed_last_day TEXT NOT NULL,
        computed_min_last_day TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence_filename TEXT,
        is_special_request INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
          ('pending','approved','rejected','cancelled','revision_requested')),
        decided_by INTEGER REFERENCES users(id),
        decided_at TEXT,
        decision_note TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO resignation_requests_new SELECT * FROM resignation_requests;
      DROP TABLE resignation_requests;
      ALTER TABLE resignation_requests_new RENAME TO resignation_requests;
      CREATE INDEX IF NOT EXISTS idx_resignation_user ON resignation_requests(user_id);
      CREATE INDEX IF NOT EXISTS idx_resignation_status ON resignation_requests(status, created_at);
      COMMIT;
    `);
  }

  // ── Phase 1D — Payroll fields on users ─────────────────────────────
  // PT = paid by hour (hourly_rate), FT = paid monthly (monthly_salary).
  // pay_cycle = 'weekly' (จันทร์) | 'monthly' (สิ้นเดือน). Default null = ยังไม่ตั้ง.
  const ucols3 = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  const unames3 = new Set(ucols3.map((c) => c.name));
  if (!unames3.has("employee_code")) db.exec("ALTER TABLE users ADD COLUMN employee_code TEXT");
  if (!unames3.has("national_id"))   db.exec("ALTER TABLE users ADD COLUMN national_id TEXT");
  if (!unames3.has("bank_name"))     db.exec("ALTER TABLE users ADD COLUMN bank_name TEXT");
  if (!unames3.has("bank_account"))  db.exec("ALTER TABLE users ADD COLUMN bank_account TEXT");
  if (!unames3.has("tax_id"))        db.exec("ALTER TABLE users ADD COLUMN tax_id TEXT");
  if (!unames3.has("sso_id"))        db.exec("ALTER TABLE users ADD COLUMN sso_id TEXT");
  if (!unames3.has("hourly_rate"))    db.exec("ALTER TABLE users ADD COLUMN hourly_rate REAL");
  if (!unames3.has("monthly_salary")) db.exec("ALTER TABLE users ADD COLUMN monthly_salary REAL");
  if (!unames3.has("pay_cycle"))      db.exec("ALTER TABLE users ADD COLUMN pay_cycle TEXT");
  // Phase 1D v2 — salary_tax_mode
  // 'sso' = ในระบบ (หักประกันสังคม 5% เพดาน sso_cap)
  // 'wht' = นอกระบบ (หักภาษี ณ ที่จ่าย 3% ไม่หักประกันสังคม)
  if (!unames3.has("salary_tax_mode")) {
    db.exec("ALTER TABLE users ADD COLUMN salary_tax_mode TEXT NOT NULL DEFAULT 'sso'");
  }

  // payroll_settings — singleton (id always = 1)
  // OT modes:
  //  'flat'  = ใช้เรทพิเศษของร้าน (default 25 บาท / 15 นาที = 100/ชม.)
  //  'legal' = ใช้กฎหมายแรงงานไทย (1.5x ของค่าจ้างต่อชั่วโมงในวันทำงานปกติ)
  db.exec(`
    CREATE TABLE IF NOT EXISTS payroll_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      ot_mode TEXT NOT NULL DEFAULT 'flat' CHECK (ot_mode IN ('flat','legal')),
      ot_flat_per_15min REAL NOT NULL DEFAULT 25,
      break_threshold_minutes INTEGER NOT NULL DEFAULT 300,
      break_deduction_minutes INTEGER NOT NULL DEFAULT 30,
      long_shift_threshold_minutes INTEGER NOT NULL DEFAULT 480,
      long_shift_break_minutes INTEGER NOT NULL DEFAULT 60,
      sso_rate REAL NOT NULL DEFAULT 0.05,
      sso_cap REAL NOT NULL DEFAULT 875,
      pt_default_hourly_rate REAL NOT NULL DEFAULT 50,
      wht_rate REAL NOT NULL DEFAULT 0.03,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by INTEGER REFERENCES users(id)
    );
    INSERT OR IGNORE INTO payroll_settings (id) VALUES (1);
  `);
  // Phase 1D v2 — bump existing rows + add new columns if upgrading
  const psCols = db.prepare("PRAGMA table_info(payroll_settings)").all() as Array<{ name: string }>;
  if (!psCols.some((c) => c.name === "wht_rate")) {
    db.exec("ALTER TABLE payroll_settings ADD COLUMN wht_rate REAL NOT NULL DEFAULT 0.03");
  }
  // Phase 1D v6 — superadmin PIN (bcrypt-hashed) for unlocking paid periods
  if (!psCols.some((c) => c.name === "superadmin_pin_hash")) {
    db.exec("ALTER TABLE payroll_settings ADD COLUMN superadmin_pin_hash TEXT");
  }
  // Bump SSO cap from old default 750 → 875 (Thai SSO ceiling adjustment)
  db.exec("UPDATE payroll_settings SET sso_cap = 875 WHERE sso_cap = 750");

  // Audit log of payroll-period events that require a PIN:
  //   - 'unlock'     paid → finalized (superadmin PIN)
  //   - 'force_open' create a period whose pay_date is still in the future
  //                  (the user's own PIN)
  db.exec(`
    CREATE TABLE IF NOT EXISTS payroll_period_unlocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
      unlocked_by INTEGER REFERENCES users(id),
      reason TEXT NOT NULL,
      unlocked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_period_unlocks_period
      ON payroll_period_unlocks(period_id);
  `);
  // Add action column for distinguishing event types (default 'unlock' for old rows)
  const puCols = db.prepare("PRAGMA table_info(payroll_period_unlocks)").all() as Array<{ name: string }>;
  if (!puCols.some((c) => c.name === "action")) {
    db.exec("ALTER TABLE payroll_period_unlocks ADD COLUMN action TEXT NOT NULL DEFAULT 'unlock'");
  }

  // ── Phase C v8 — messaging_channels (multi-channel LINE OA) ─────────
  // Platform channels (scope='platform') = OA ที่ใช้ทุก module ของ IKIGAI ONE
  //   ตัวอย่าง: code='ikigai-os' ใช้กับ PERSONA (clock-in card) + ASCENDA
  // Per-branch channels (scope='reserva') = OA ของแต่ละร้าน — เก็บไว้สำหรับ
  //   อนาคต ตอนนี้ RESERVA ยังอ่านจาก branches.line_channel_token เป็นหลัก
  db.exec(`
    CREATE TABLE IF NOT EXISTS messaging_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL CHECK (scope IN ('platform','reserva')),
      code TEXT UNIQUE NOT NULL,                  -- slug used in webhook URL
      label TEXT NOT NULL,                        -- 'IKIGAI OS', 'NAMA PASTA SRIRACHA'
      branch_id INTEGER REFERENCES branches(id),  -- NULL when scope='platform'
      channel_secret TEXT,
      channel_token TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by INTEGER REFERENCES users(id)
    );
    INSERT OR IGNORE INTO messaging_channels (scope, code, label)
      VALUES ('platform', 'ikigai-os', 'IKIGAI OS');
  `);
  // Phase C v9 — LIFF ID per channel (RESERVA needs it on the booking page
  // to auto-capture the customer's LINE userId when they tap the Rich Menu).
  // Lives on messaging_channels even though the LIFF app is created under a
  // separate LINE Login channel — the Bot link feature pairs them.
  const mcCols = db.prepare("PRAGMA table_info(messaging_channels)").all() as Array<{ name: string }>;
  if (!mcCols.some((c) => c.name === "liff_id")) {
    db.exec("ALTER TABLE messaging_channels ADD COLUMN liff_id TEXT");
  }

  // Auto-seed one row per branch (code = branch.slug, scope='reserva') so
  // the admin UI always has something to render. Idempotent — INSERT OR
  // IGNORE on the unique 'code' column.
  db.exec(`
    INSERT OR IGNORE INTO messaging_channels (scope, code, label, branch_id)
    SELECT 'reserva', slug, name, id FROM branches
  `);

  // Migrate any legacy per-branch creds (branches.line_channel_token/secret)
  // into the new messaging_channels rows. Only fills empty slots — never
  // overwrites a value already entered through the new admin UI.
  db.exec(`
    UPDATE messaging_channels
    SET channel_token = (
      SELECT b.line_channel_token FROM branches b
      WHERE b.id = messaging_channels.branch_id
    )
    WHERE scope = 'reserva'
      AND channel_token IS NULL
      AND EXISTS (
        SELECT 1 FROM branches b
        WHERE b.id = messaging_channels.branch_id
          AND b.line_channel_token IS NOT NULL
      );
    UPDATE messaging_channels
    SET channel_secret = (
      SELECT b.line_channel_secret FROM branches b
      WHERE b.id = messaging_channels.branch_id
    )
    WHERE scope = 'reserva'
      AND channel_secret IS NULL
      AND EXISTS (
        SELECT 1 FROM branches b
        WHERE b.id = messaging_channels.branch_id
          AND b.line_channel_secret IS NOT NULL
      );
  `);

  // ── One-time payroll data wipe (per user request to start fresh) ──
  // Tracked via PRAGMA user_version so it runs exactly once per database.
  const userVer = db.pragma("user_version", { simple: true }) as number;
  if (userVer < 1) {
    db.exec(`
      DELETE FROM payroll_period_unlocks;
      DELETE FROM payroll_lines;
      DELETE FROM payroll_periods;
    `);
    db.pragma("user_version = 1");
  }

  // ── Phase 1D / C2 — Payroll periods + lines ────────────────────────
  // payroll_periods = หนึ่งรอบจ่าย (รายสัปดาห์ จันทร์-อาทิตย์ หรือ รายเดือน)
  // payroll_lines   = หนึ่งบรรทัด ต่อ พนักงาน ต่อ รอบ — snapshot ของการคำนวณ
  db.exec(`
    CREATE TABLE IF NOT EXISTS payroll_periods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle TEXT NOT NULL CHECK (cycle IN ('weekly','monthly')),
      period_start TEXT NOT NULL,                  -- YYYY-MM-DD inclusive (Bangkok)
      period_end TEXT NOT NULL,                    -- YYYY-MM-DD inclusive
      pay_date TEXT NOT NULL,                      -- YYYY-MM-DD วันที่จ่ายจริง
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','finalized','cancelled')),
      ot_mode_snapshot TEXT,                       -- snapshot ตอนคำนวณครั้งแรก
      ot_flat_per_15min_snapshot REAL,
      computed_by INTEGER REFERENCES users(id),
      computed_at TEXT,
      finalized_by INTEGER REFERENCES users(id),
      finalized_at TEXT,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (cycle, period_start, period_end)
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_periods_dates
      ON payroll_periods(period_start, period_end);
    CREATE INDEX IF NOT EXISTS idx_payroll_periods_status
      ON payroll_periods(status, period_end);

    CREATE TABLE IF NOT EXISTS payroll_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      -- snapshot of employee at compute time
      employee_code TEXT,
      display_name TEXT NOT NULL,
      employment_type TEXT,                        -- 'pt' | 'ft' | NULL
      pay_cycle_snapshot TEXT,                     -- 'weekly' | 'monthly' | NULL
      hourly_rate_snapshot REAL,
      monthly_salary_snapshot REAL,
      salary_tax_mode_snapshot TEXT,               -- 'sso' | 'wht' (Phase 1D v2)
      holiday_minutes INTEGER NOT NULL DEFAULT 0,  -- minutes worked on public_holidays (PT premium)
      -- time/work data (minutes)
      shift_minutes INTEGER NOT NULL DEFAULT 0,    -- ก่อนหักพัก
      break_deducted_minutes INTEGER NOT NULL DEFAULT 0,
      regular_minutes INTEGER NOT NULL DEFAULT 0,
      ot_minutes INTEGER NOT NULL DEFAULT 0,
      days_worked INTEGER NOT NULL DEFAULT 0,
      leave_days REAL NOT NULL DEFAULT 0,
      unpaired_clockins INTEGER NOT NULL DEFAULT 0,
      -- pay components (THB)
      base_pay REAL NOT NULL DEFAULT 0,
      ot_pay REAL NOT NULL DEFAULT 0,
      service_charge REAL NOT NULL DEFAULT 0,
      other_additions REAL NOT NULL DEFAULT 0,
      gross_pay REAL NOT NULL DEFAULT 0,
      sso_amount REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      other_deductions REAL NOT NULL DEFAULT 0,
      net_pay REAL NOT NULL DEFAULT 0,
      -- manual override (admin can adjust + add note)
      overridden INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (period_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_lines_period
      ON payroll_lines(period_id);
    CREATE INDEX IF NOT EXISTS idx_payroll_lines_user
      ON payroll_lines(user_id);
  `);

  // Phase 1D v2 — add new columns to existing payroll_lines if upgrading
  const plCols = db.prepare("PRAGMA table_info(payroll_lines)").all() as Array<{ name: string }>;
  const plNames = new Set(plCols.map((c) => c.name));
  if (!plNames.has("salary_tax_mode_snapshot")) {
    db.exec("ALTER TABLE payroll_lines ADD COLUMN salary_tax_mode_snapshot TEXT");
  }
  if (!plNames.has("holiday_minutes")) {
    db.exec("ALTER TABLE payroll_lines ADD COLUMN holiday_minutes INTEGER NOT NULL DEFAULT 0");
  }

  // Phase 1D v3 — payroll_periods.target ('pt' | 'ft' | 'all')
  // 'pt' = พนักงานพาร์ทไทม์เท่านั้น (รายชั่วโมง)
  // 'ft' = พนักงานประจำเท่านั้น (เงินเดือน, รายสัปดาห์ หรือรายเดือนตาม pay_cycle)
  // 'all' = legacy / mixed — เก็บไว้เพื่อ backward compat ของ row เก่า
  const ppCols = db.prepare("PRAGMA table_info(payroll_periods)").all() as Array<{ name: string }>;
  const ppNames = new Set(ppCols.map((c) => c.name));
  if (!ppNames.has("target")) {
    db.exec("ALTER TABLE payroll_periods ADD COLUMN target TEXT NOT NULL DEFAULT 'all'");
  }

  // Phase 1D v4 — paid status + data_source
  if (!ppNames.has("paid_at")) {
    db.exec("ALTER TABLE payroll_periods ADD COLUMN paid_at TEXT");
  }
  if (!ppNames.has("paid_by")) {
    db.exec("ALTER TABLE payroll_periods ADD COLUMN paid_by INTEGER REFERENCES users(id)");
  }
  // 'auto'   = compute regular/OT minutes from time_entries + leave_requests
  // 'manual' = create empty rows; admin types hours/days manually
  if (!ppNames.has("data_source")) {
    db.exec("ALTER TABLE payroll_periods ADD COLUMN data_source TEXT NOT NULL DEFAULT 'auto'");
  }
  // Phase 1D v5 — pay_date for monthly periods is now "5th of NEXT month".
  // Backfill existing DRAFT monthly periods that still use period_end as pay_date
  // (the old default was period_end). Finalized/paid periods are left untouched.
  db.exec(`
    UPDATE payroll_periods
    SET pay_date = printf(
      '%04d-%02d-05',
      CASE WHEN CAST(substr(period_end, 6, 2) AS INTEGER) = 12
           THEN CAST(substr(period_end, 1, 4) AS INTEGER) + 1
           ELSE CAST(substr(period_end, 1, 4) AS INTEGER)
      END,
      CASE WHEN CAST(substr(period_end, 6, 2) AS INTEGER) = 12
           THEN 1
           ELSE CAST(substr(period_end, 6, 2) AS INTEGER) + 1
      END
    )
    WHERE cycle = 'monthly' AND status = 'draft' AND pay_date = period_end;
  `);

  // Recreate payroll_periods if status CHECK doesn't include 'paid' (SQLite has no ALTER CHECK)
  const ppSql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='payroll_periods'"
  ).get() as { sql: string } | undefined;
  if (ppSql && !ppSql.sql.includes("'paid'")) {
    db.exec(`
      BEGIN;
      CREATE TABLE payroll_periods_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cycle TEXT NOT NULL CHECK (cycle IN ('weekly','monthly')),
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        pay_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK (status IN ('draft','finalized','cancelled','paid')),
        ot_mode_snapshot TEXT,
        ot_flat_per_15min_snapshot REAL,
        computed_by INTEGER REFERENCES users(id),
        computed_at TEXT,
        finalized_by INTEGER REFERENCES users(id),
        finalized_at TEXT,
        notes TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        target TEXT NOT NULL DEFAULT 'all',
        paid_at TEXT,
        paid_by INTEGER REFERENCES users(id),
        data_source TEXT NOT NULL DEFAULT 'auto',
        UNIQUE (cycle, period_start, period_end)
      );
      INSERT INTO payroll_periods_new
        (id, cycle, period_start, period_end, pay_date, status,
         ot_mode_snapshot, ot_flat_per_15min_snapshot,
         computed_by, computed_at, finalized_by, finalized_at,
         notes, created_by, created_at, target, paid_at, paid_by, data_source)
      SELECT id, cycle, period_start, period_end, pay_date, status,
             ot_mode_snapshot, ot_flat_per_15min_snapshot,
             computed_by, computed_at, finalized_by, finalized_at,
             notes, created_by, created_at,
             COALESCE(target, 'all'),
             paid_at, paid_by,
             COALESCE(data_source, 'auto')
      FROM payroll_periods;
      DROP TABLE payroll_periods;
      ALTER TABLE payroll_periods_new RENAME TO payroll_periods;
      CREATE INDEX IF NOT EXISTS idx_payroll_periods_dates
        ON payroll_periods(period_start, period_end);
      CREATE INDEX IF NOT EXISTS idx_payroll_periods_status
        ON payroll_periods(status, period_end);
      COMMIT;
    `);
  }

  // ─────────────────────────────────────────────────────────────
  // TC-P (Profile Phase A) — multi-tenant companies + expanded
  // employee fields + disciplinary warning system.
  //
  // companies   — top-level tenant. A branch belongs to one company.
  //               Future expansion: more companies in the group can
  //               own their own branches; staff can move between
  //               companies via user_branches.
  //
  // users add-ons — Phase A profile fields the owner needs for
  //                 payroll/HR (title prefix, names, DOB, addresses,
  //                 emergency contact, job title, supervisor, ...).
  //
  // disciplinary_warnings + disciplinary_warning_views — written-
  //                 warning letters admin issues to staff. Staff has
  //                 to PIN-acknowledge, OR the system auto-
  //                 acknowledges if they viewed it and then left the
  //                 page (so "I never saw it" can't be claimed).
  // ─────────────────────────────────────────────────────────────

  db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_th TEXT NOT NULL,
      name_en TEXT,
      tax_id TEXT,
      address TEXT,
      phone TEXT,
      email TEXT,
      logo_url TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed the default company on first run so existing branches have
  // somewhere to point. Name comes from the owner's empeo screenshot.
  const companyCount = (db.prepare(
    "SELECT COUNT(*) AS n FROM companies"
  ).get() as { n: number }).n;
  if (companyCount === 0) {
    db.prepare(`
      INSERT INTO companies (name_th, name_en)
      VALUES (?, ?)
    `).run("บริษัท อิคิไก เวลล์เกรด จำกัด", "Ikigai Wellgrade Co., Ltd.");
  }

  // branches.company_id — FK to companies. We backfill to the lowest
  // company id (the seed above) for legacy branches that pre-date
  // this column.
  const branchCols = db.prepare("PRAGMA table_info(branches)").all() as Array<{ name: string }>;
  const branchColNames = new Set(branchCols.map((c) => c.name));
  if (!branchColNames.has("company_id")) {
    db.exec("ALTER TABLE branches ADD COLUMN company_id INTEGER REFERENCES companies(id)");
    const defaultCompanyId = (db.prepare(
      "SELECT id FROM companies ORDER BY id ASC LIMIT 1"
    ).get() as { id: number } | undefined)?.id ?? null;
    if (defaultCompanyId) {
      db.prepare("UPDATE branches SET company_id = ? WHERE company_id IS NULL").run(defaultCompanyId);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Multi-tenant RBAC.
  //
  // Companies are owner-managed via /admin/companies — the migration
  // does NOT seed or rename them (an earlier auto-seed created a
  // duplicate when the owner's chosen names didn't match the
  // hard-coded ones). It only guarantees the two extra branches
  // exist as selectable rows; company assignment is done in the UI.
  //
  // user_branches.is_admin — per-branch admin grant. A sub-admin
  // only manages branches where this flag is 1; super_admin is
  // global and ignores it. Existing rows default to 0 (plain
  // membership, no admin powers) — super_admin grants explicitly.
  // ─────────────────────────────────────────────────────────────

  // New branches (idempotent by slug). NAMA + HYPOPLARAEMIA already
  // exist from db:init; only the two clinic/lab branches are added.
  // company_id stays NULL — the owner assigns it on /admin/companies.
  const ensureBranch = db.prepare(
    "INSERT OR IGNORE INTO branches (slug, name) VALUES (?, ?)"
  );
  ensureBranch.run("at-home-clinic", "AT HOME CLINIC");
  ensureBranch.run("omnia-health-lab", "OMNIA HEALTH LABORATORY");

  // user_branches.is_admin — idempotent column add (PRAGMA-guarded).
  const ubCols = db.prepare("PRAGMA table_info(user_branches)").all() as Array<{ name: string }>;
  if (!ubCols.some((c) => c.name === "is_admin")) {
    db.exec("ALTER TABLE user_branches ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
  }

  // users — Phase A profile columns. All nullable (existing rows
  // keep working). Idempotent per-column ALTER.
  const phaseAUserCols = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  const phaseAUserSet = new Set(phaseAUserCols.map((c) => c.name));
  const userCol = (name: string, ddl: string) => {
    if (!phaseAUserSet.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${ddl}`);
  };
  // Personal
  userCol("title_prefix",   "TEXT");      // นาย / นาง / นางสาว / ฯลฯ
  userCol("first_name_th",  "TEXT");
  userCol("last_name_th",   "TEXT");
  userCol("first_name_en",  "TEXT");
  userCol("last_name_en",   "TEXT");
  userCol("nickname_th",    "TEXT");
  userCol("nickname_en",    "TEXT");
  userCol("dob",            "TEXT");      // YYYY-MM-DD
  userCol("nationality",    "TEXT");
  userCol("race",           "TEXT");
  userCol("religion",       "TEXT");
  userCol("marital_status", "TEXT");      // single / married / divorced / widowed
  userCol("military_status","TEXT");      // exempt / passed / pending / served
  userCol("blood_type",     "TEXT");      // A / B / AB / O (+/-)
  userCol("height_cm",      "REAL");
  userCol("weight_kg",      "REAL");
  userCol("personal_notes", "TEXT");
  // Contact
  userCol("personal_email", "TEXT");
  userCol("corporate_email","TEXT");
  userCol("mobile_phone",   "TEXT");
  userCol("work_phone",     "TEXT");
  userCol("line_id",        "TEXT");      // human-readable LINE handle (NOT the userId)
  userCol("house_address",      "TEXT");
  userCol("house_subdistrict",  "TEXT");
  userCol("house_district",     "TEXT");
  userCol("house_province",     "TEXT");
  userCol("house_postcode",     "TEXT");
  userCol("contact_address",        "TEXT");
  userCol("contact_subdistrict",    "TEXT");
  userCol("contact_district",       "TEXT");
  userCol("contact_province",       "TEXT");
  userCol("contact_postcode",       "TEXT");
  userCol("contact_same_as_house",  "INTEGER NOT NULL DEFAULT 0");
  userCol("emergency_name",         "TEXT");
  userCol("emergency_relationship", "TEXT");
  userCol("emergency_phone",        "TEXT");
  // Employment
  userCol("supervisor_user_id", "INTEGER REFERENCES users(id)");
  userCol("job_title",          "TEXT");  // free-text เช่น "พนักงานทั่วไปภายในร้าน"
  userCol("contract_end_date",  "TEXT");  // YYYY-MM-DD
  userCol("employment_status",  "TEXT");  // probation / permanent
  userCol("track_attendance",   "INTEGER NOT NULL DEFAULT 1");  // 0 = admin/exec doesn't clock in
  userCol("hire_mode",          "TEXT");  // monthly / daily / hourly
  userCol("payment_method",     "TEXT");  // bank / cash
  userCol("driver_license_no",  "TEXT");
  userCol("manpower_type",      "TEXT");  // new / replacement
  // Self-onboarding gate: when 1, staff is allowed to edit their own
  // profile via /staff/persona/profile. Admin flips to 0 after they
  // confirm the data is complete (so staff can't change KYC fields).
  userCol("profile_self_edit_open", "INTEGER NOT NULL DEFAULT 1");
  // Face-scan opt-in photo URL (path under /uploads/face/<uuid>.jpg
  // when present). Optional — not all branches use face scan.
  userCol("face_photo_url",     "TEXT");

  // Disciplinary warnings (TC-P §8).
  //   Severity ladder: verbal → written_1 → written_2 → final.
  //   acknowledged_method:
  //     'pin_explicit'  — staff entered correct PIN and tapped Acknowledge
  //     'auto_on_leave' — staff opened the warning, didn't ack, and
  //                       left the page. The client beforeunload
  //                       handler POSTs auto-ack so the warning is
  //                       counted as "seen + tacitly accepted".
  db.exec(`
    CREATE TABLE IF NOT EXISTS disciplinary_warnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      issued_by_user_id INTEGER NOT NULL REFERENCES users(id),
      issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      severity TEXT NOT NULL CHECK (severity IN ('verbal','written_1','written_2','final')),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      reason_category TEXT,
      evidence_filename TEXT,
      effective_date TEXT,
      acknowledged_at TEXT,
      acknowledged_method TEXT CHECK (acknowledged_method IN ('pin_explicit','auto_on_leave')),
      auto_ack_reason TEXT,
      ref_no TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_discipline_user_status
      ON disciplinary_warnings(user_id, acknowledged_at);
    CREATE INDEX IF NOT EXISTS idx_discipline_branch_issued
      ON disciplinary_warnings(branch_id, issued_at);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS disciplinary_warning_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      warning_id INTEGER NOT NULL REFERENCES disciplinary_warnings(id) ON DELETE CASCADE,
      viewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ip TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_discipline_view_warning
      ON disciplinary_warning_views(warning_id, viewed_at);
  `);

  // ─────────────────────────────────────────────────────────────
  // TC-A (Account management + RBAC) — 2026-05-14
  //
  //   users.role is widened from {admin,staff} to {super_admin,admin,
  //   staff} via an in-place column rewrite — the legacy CHECK
  //   constraint on the existing column doesn't include super_admin.
  //
  //   users.status — gates login. pending_invite means the row was
  //   created by an admin but the staff hasn't redeemed their invite
  //   link yet (so username/password/PIN aren't set).
  //
  //   invites — single-use, 7-day-TTL tokens admin generates to
  //   onboard new staff via LINE. Each row links to a user_id; opening
  //   the link in LINE captures the staff's LIFF userId and binds it
  //   back to the user.
  //
  //   emergency_credentials — admin-issued 24h-TTL username+password
  //   override so staff can log in without LINE in a pinch
  //   (phone dead, account locked, etc.). Once the staff logs in
  //   with one, it's marked used.
  //
  //   impersonation_log — every time super_admin or admin "logs in as"
  //   a staff for debugging, a row is appended. Required for
  //   defensible audit ("who did what" must distinguish the real
  //   actor from the impersonated session).
  // ─────────────────────────────────────────────────────────────

  // Widen users.role CHECK to include 'super_admin'. Existing rows
  // keep their value; only the constraint changes. Same in-place
  // technique used for bookings.status earlier.
  const userTableDdl = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'"
  ).get() as { sql: string } | undefined;
  if (userTableDdl && /CHECK\s*\(\s*role\s+IN\s*\([^)]*\)/i.test(userTableDdl.sql)
      && !/'super_admin'/.test(userTableDdl.sql)) {
    const userCols = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    const colList = userCols.map((c) => `"${c.name}"`).join(", ");
    const newDdl = userTableDdl.sql.replace(
      /CHECK\s*\(\s*role\s+IN\s*\([^)]+\)\s*\)/i,
      "CHECK (role IN ('super_admin','admin','staff'))"
    ).replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?users["`]?\b/i, "CREATE TABLE users_new");
    db.exec("BEGIN");
    try {
      db.exec(newDdl);
      db.exec(`INSERT INTO users_new (${colList}) SELECT ${colList} FROM users`);
      db.exec("DROP TABLE users");
      db.exec("ALTER TABLE users_new RENAME TO users");
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  // users.status — gates login. 'active' is the default for legacy rows.
  const userColsForStatus = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!userColsForStatus.some((c) => c.name === "status")) {
    db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending_invite','disabled'))");
  }
  if (!userColsForStatus.some((c) => c.name === "last_login_at")) {
    db.exec("ALTER TABLE users ADD COLUMN last_login_at TEXT");
  }

  // Promote the bootstrap 'admin' account to super_admin so the
  // setup wizard / role grants have a starting point. Idempotent
  // (only runs when nobody is currently super_admin).
  const hasSuperAdmin = (db.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin'"
  ).get() as { n: number }).n;
  if (hasSuperAdmin === 0) {
    db.prepare(
      "UPDATE users SET role = 'super_admin' WHERE username = 'admin'"
    ).run();
  }

  // Invites — single-use tokens admin generates to onboard new staff.
  db.exec(`
    CREATE TABLE IF NOT EXISTS invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      kind TEXT NOT NULL DEFAULT 'onboard' CHECK (kind IN ('onboard','reset','rebind_line'))
    );
    CREATE INDEX IF NOT EXISTS idx_invites_user ON invites(user_id);
    CREATE INDEX IF NOT EXISTS idx_invites_token ON invites(token);
  `);

  // Emergency credentials — 24h temporary login override.
  db.exec(`
    CREATE TABLE IF NOT EXISTS emergency_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      temp_username TEXT NOT NULL UNIQUE,
      temp_password_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TEXT,
      revoke_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_emergency_user ON emergency_credentials(user_id);
    CREATE INDEX IF NOT EXISTS idx_emergency_temp_username ON emergency_credentials(temp_username);
  `);

  // Impersonation log — non-deletable audit trail. Every "log in as"
  // by super_admin or admin appends a row at start + closes on stop.
  db.exec(`
    CREATE TABLE IF NOT EXISTS impersonation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      impersonator_id INTEGER NOT NULL REFERENCES users(id),
      target_user_id INTEGER NOT NULL REFERENCES users(id),
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ended_at TEXT,
      reason TEXT,
      ip TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_impersonation_active
      ON impersonation_log(impersonator_id, ended_at)
      WHERE ended_at IS NULL;
  `);

  // Employee health check-ups — food-handler medical certificate
  // (แบบ ส.ณ.11 / ผู้สัมผัสอาหาร). One row per certificate; the
  // per-disease checklist is stored as JSON in items_json so the
  // reference item list can evolve without a migration. We keep full
  // history (multiple rows per user); the UI shows the latest by
  // checkup_date and derives valid/expiring/expired from expiry_date.
  db.exec(`
    CREATE TABLE IF NOT EXISTS health_checkups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      branch_id INTEGER REFERENCES branches(id),
      checkup_date TEXT NOT NULL,
      expiry_date TEXT,
      clinic_name TEXT,
      doctor_name TEXT,
      cert_no TEXT,
      overall_result TEXT NOT NULL DEFAULT 'pass'
        CHECK (overall_result IN ('pass','fail','conditional')),
      items_json TEXT,
      attachment_url TEXT,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_health_checkups_user
      ON health_checkups(user_id, checkup_date DESC);
    CREATE INDEX IF NOT EXISTS idx_health_checkups_branch
      ON health_checkups(branch_id);
  `);

  // ── INVENTA — clinic stock-count module ──────────────────────────
  // Per-branch drug/equipment inventory. Items live in a physical grid
  // (row A–E × col 1–6) with a pick-frequency colour (R rare / Y med /
  // G frequent) so the bin code "D4R" helps new staff find things.
  // unit_cost is always per *smallest* unit (e.g. per tablet) — derived
  // from a purchase price ÷ total smallest-unit qty so order rounds can
  // be costed even when bills quote packs/strips. Expiry is out of
  // scope for v1 (APSX is the system of record for that).
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventa_suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER REFERENCES branches(id),
      name TEXT NOT NULL,
      order_cycle TEXT,
      lead_time TEXT,
      contact TEXT,
      note TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_inventa_suppliers_branch
      ON inventa_suppliers(branch_id);

    CREATE TABLE IF NOT EXISTS inventa_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER REFERENCES branches(id),
      item_code TEXT,
      barcode TEXT,
      name TEXT NOT NULL,
      generic_name TEXT,
      cgd_code TEXT,
      category TEXT,
      item_type TEXT NOT NULL DEFAULT 'drug'
        CHECK (item_type IN ('drug','equipment')),
      unit TEXT,
      unit_cost REAL NOT NULL DEFAULT 0,
      last_purchase_price REAL,
      last_purchase_units REAL,
      price_opd REAL,
      price_ipd REAL,
      price_uc REAL,
      supplier_id INTEGER REFERENCES inventa_suppliers(id),
      grid_row TEXT,
      grid_col INTEGER,
      pick_freq TEXT CHECK (pick_freq IN ('R','Y','G')),
      safety_stock INTEGER NOT NULL DEFAULT 50,
      current_qty INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_inventa_items_branch
      ON inventa_items(branch_id, active);
    CREATE INDEX IF NOT EXISTS idx_inventa_items_barcode
      ON inventa_items(barcode);

    CREATE TABLE IF NOT EXISTS inventa_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER REFERENCES branches(id),
      count_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','submitted')),
      note TEXT,
      counted_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      submitted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_inventa_counts_branch
      ON inventa_counts(branch_id, count_date DESC);

    CREATE TABLE IF NOT EXISTS inventa_count_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      count_id INTEGER NOT NULL REFERENCES inventa_counts(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES inventa_items(id),
      prev_qty INTEGER,
      counted_qty INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_inventa_count_lines_count
      ON inventa_count_lines(count_id);

    CREATE TABLE IF NOT EXISTS inventa_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER REFERENCES branches(id),
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','sent','approved','received','cancelled')),
      note TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sent_at TEXT,
      approved_by INTEGER REFERENCES users(id),
      approved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_inventa_orders_branch
      ON inventa_orders(branch_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS inventa_order_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES inventa_orders(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES inventa_items(id),
      supplier_id INTEGER REFERENCES inventa_suppliers(id),
      qty_on_hand INTEGER,
      suggested_qty INTEGER,
      order_qty INTEGER NOT NULL DEFAULT 0,
      unit_cost_at_order REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_inventa_order_lines_order
      ON inventa_order_lines(order_id);
  `);

  // INVENTA configurable lookups — admin-editable option lists used by
  // the item form (grid row prefixes, storage cabinets, smallest-unit
  // names, drug categories). kind discriminates the list. branch_id
  // NULL = global default seen by every branch; a branch can add its
  // own rows on top.
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventa_lookups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER REFERENCES branches(id),
      kind TEXT NOT NULL
        CHECK (kind IN ('row','storage','unit','category')),
      value TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 100,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_inventa_lookups_kind
      ON inventa_lookups(kind, active);
  `);

  // Storage-cabinet column on items (ตู้ยา / ตู้เก็บยาควบคุม / ตู้เย็น).
  const invCols = db.prepare("PRAGMA table_info(inventa_items)")
    .all() as Array<{ name: string }>;
  if (!invCols.some((c) => c.name === "storage_location")) {
    db.exec("ALTER TABLE inventa_items ADD COLUMN storage_location TEXT");
  }

  // One-time global seed so a fresh clinic isn't staring at empty
  // dropdowns. Only runs when the table is completely empty.
  const lkCount = (db.prepare("SELECT COUNT(*) AS n FROM inventa_lookups")
    .get() as { n: number }).n;
  if (lkCount === 0) {
    const ins = db.prepare(
      "INSERT INTO inventa_lookups (branch_id, kind, value, sort_order) VALUES (NULL,?,?,?)"
    );
    const seed = (kind: string, vals: string[]) =>
      vals.forEach((v, i) => ins.run(kind, v, (i + 1) * 10));

    seed("row", ["A", "B", "C", "D", "E", "F"]);
    seed("storage", ["ตู้ยา", "ตู้เก็บยาควบคุม", "ตู้เย็น", "ชั้นวางทั่วไป"]);
    seed("unit", ["เม็ด", "แคปซูล", "ขวด", "แอมป์", "หลอด", "ซอง", "กล่อง", "ชิ้น", "แผง"]);
    seed("category", [
      "กลุ่มยาทั่วไป General Drugs",
      "กลุ่มยา NSAIDs",
      "กลุ่มยาปฏิชีวนะ - Penicillins",
      "กลุ่มยาปฏิชีวนะ - Sulfonamides",
      "กลุ่มยาปฏิชีวนะ - Macrolides",
      "กลุ่มยาปฏิชีวนะ - Fluoroquinolones",
      "กลุ่มยาปฏิชีวนะ - Cephalosporins",
      "กลุ่มยารักษาโรคระบบทางเดินอาหาร - กระเพาะอาหาร",
      "กลุ่มยารักษาโรคระบบทางเดินอาหาร - โรคท้องเสีย",
      "กลุ่มยารักษาโรคระบบทางเดินหายใจ - หวัดที่มีอาการไอ",
      "กลุ่มยารักษาโรคระบบทางเดินหายใจ - โรคหอบหืด",
      "กลุ่มยารักษาโรคระบบสมองและระบบประสาท - อื่นๆ",
      "กลุ่มยารักษาโรคความดันโลหิตสูง",
      "กลุ่มยารักษาโรคระบบผิวหนัง - ผื่นคันที่ผิวหนัง",
      "กลุ่มยารักษาโรคระบบผิวหนัง - ผิวหนังอักเสบติดเชื้อ",
      "กลุ่มยารักษาโรคระบบต่อมไร้ท่อ",
      "กลุ่มยารักษาโรคในระบบกล้ามเนื้อ กระดูกและข้อ - ยาคลายกล้ามเนื้อ",
      "กลุ่มยารักษาอาการในภาวะฉุกเฉิน",
      "กลุ่มยาอื่นๆ - ไม่ระบุ",
      "GS02 Bag"
    ]);
  }
}

/** One row in the daily attendance roster — used by the group
 *  summary Flex card that lands in the shared staff group each
 *  time someone clocks in / out. */
export type AttendanceRow = {
  userId: number;
  displayName: string;
  employmentType: string | null;   // 'pt' / 'ft' / null
  inTs: string | null;             // ISO timestamp of today's first clock-in
  outTs: string | null;            // ISO timestamp of today's first clock-out
};

/** Build today's attendance roster for a branch. Returns one row per
 *  staff member assigned to the branch (via user_branches), sorted
 *  by display_name. Rows include the in/out timestamps when present
 *  so the caller can format "✓ มาแล้ว @08:32" vs "⏳ ยังไม่มา"
 *  without another query.
 *
 *  Time entries are scoped to the given Bangkok-local date so a
 *  late-night clock-out from the previous day doesn't leak into
 *  tomorrow's summary. */
export function getBranchAttendanceSummary(
  branchId: number,
  dateBkk: string
): AttendanceRow[] {
  const db = getDb();
  const startIso = new Date(`${dateBkk}T00:00:00+07:00`).toISOString();
  const endIso = new Date(`${dateBkk}T23:59:59+07:00`).toISOString();
  // LEFT JOIN time_entries twice (in + out) so users with neither
  // event today still appear in the roster as "absent".
  const rows = db.prepare(`
    SELECT u.id AS userId,
           u.display_name AS displayName,
           u.employment_type AS employmentType,
           (
             SELECT te.ts FROM time_entries te
             WHERE te.user_id = u.id AND te.branch_id = ?
               AND te.type = 'in' AND te.ts >= ? AND te.ts <= ?
             ORDER BY te.ts ASC LIMIT 1
           ) AS inTs,
           (
             SELECT te.ts FROM time_entries te
             WHERE te.user_id = u.id AND te.branch_id = ?
               AND te.type = 'out' AND te.ts >= ? AND te.ts <= ?
             ORDER BY te.ts ASC LIMIT 1
           ) AS outTs
    FROM users u
    JOIN user_branches ub ON ub.user_id = u.id
    WHERE ub.branch_id = ? AND u.role = 'staff'
    ORDER BY u.display_name COLLATE NOCASE ASC
  `).all(
    branchId, startIso, endIso,
    branchId, startIso, endIso,
    branchId
  ) as AttendanceRow[];
  return rows;
}

/** Append a row to persona_activity_log. Minimal interface — caller
 *  just supplies who did what + optional ref_id pointing at the
 *  affected row. Logging is best-effort; we swallow errors so a log
 *  insert can't take down the request (audit trails should never
 *  block the user-facing flow). */
export function logPersonaAction(
  userId: number,
  action: string,
  refId?: number | null
): void {
  try {
    getDb().prepare(`
      INSERT INTO persona_activity_log (user_id, action, ref_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(userId, action, refId ?? null, new Date().toISOString());
  } catch (e) {
    console.warn("logPersonaAction failed:", e);
  }
}

/** Fetch the system_settings singleton. The migration seeds the row
 *  on first boot so this never returns undefined — but we narrow
 *  via the result cast anyway for downstream safety. */
export function getSystemSettings(): SystemSettings {
  const row = getDb().prepare("SELECT * FROM system_settings WHERE id = 1").get() as
    | SystemSettings
    | undefined;
  // Defensive fallback if the seed somehow didn't run — return an
  // empty config rather than crashing callers that just want to
  // check "is global OA configured yet?".
  if (!row) {
    return {
      id: 1,
      global_line_channel_token: null,
      global_staff_group_id: null,
      updated_at: null,
      updated_by: null
    };
  }
  return row;
}

/** Write the singleton system_settings row. Treats empty strings as
 *  NULL so admin can clear a field by leaving it blank rather than
 *  having to type "null" or similar. */
export function updateSystemSettings(
  patch: {
    global_line_channel_token?: string | null;
    global_staff_group_id?: string | null;
  },
  updatedBy: number
): void {
  const norm = (v: string | null | undefined): string | null => {
    if (v === undefined) return undefined as unknown as string | null; // sentinel — leave unchanged
    const t = (v ?? "").trim();
    return t === "" ? null : t;
  };
  // Build dynamic UPDATE so callers can patch a subset of fields
  // without overwriting the others to NULL.
  const sets: string[] = [];
  const vals: Array<string | number | null> = [];
  if (Object.prototype.hasOwnProperty.call(patch, "global_line_channel_token")) {
    sets.push("global_line_channel_token = ?");
    vals.push(norm(patch.global_line_channel_token ?? null));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "global_staff_group_id")) {
    sets.push("global_staff_group_id = ?");
    vals.push(norm(patch.global_staff_group_id ?? null));
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?", "updated_by = ?");
  vals.push(new Date().toISOString(), updatedBy);
  getDb().prepare(
    `UPDATE system_settings SET ${sets.join(", ")} WHERE id = 1`
  ).run(...vals);
}

export type Branch = {
  id: number;
  slug: string;
  name: string;
  company_id: number | null;
  open_time: string;
  close_time: string;
  slot_minutes: number;
  default_duration_minutes: number;
  reminder_minutes_before: number;
  line_channel_secret: string | null;
  line_channel_token: string | null;
  staff_line_user_ids: string | null;
  status: "open" | "coming_soon";
  opens_on: string | null;          // YYYY-MM-DD เมื่อ status = coming_soon
  closed_weekdays: string | null;   // JSON array of 0-6, e.g., '[1]' = ปิดทุกจันทร์
  lunch_break_start: string | null; // HH:MM
  lunch_break_end: string | null;   // HH:MM
  lunch_break_weekdays: string | null;  // JSON array of 0-6
  no_lunch_break_dates: string | null;  // JSON array of YYYY-MM-DD
  display_order: number;            // sort key, lower = first (NAMA = 1)
  extra_button_label: string | null;   // Customer Flex card secondary CTA label
  extra_button_url: string | null;     // Customer Flex card secondary CTA URL
  contact_phone: string | null;        // Fallback phone shown in pending-confirmation LINE message
  staff_group_id: string | null;       // LINE group ID for staff notifications (preferred over staff_line_user_ids when set)
  readiness_morning_time: string;      // HH:MM — used in รอบเช้า card title (e.g. "11:30")
  readiness_afternoon_time: string;    // HH:MM — used in รอบบ่าย card title (e.g. "16:00")
  brand_color: string | null;          // Hex e.g. '#e94560'. NULL = default IKIGAI ink colour.
  // PERSONA Time Clock anti-cheat — see schema migration in getDb().
  latitude: number | null;
  longitude: number | null;
  geofence_radius_meters: number;
  geofence_enabled: number;            // 0/1
  clock_qr_token: string | null;
  clock_qr_enabled: number;            // 0/1
  // Daily attendance summary (TC-6) — see migration block above.
  attendance_summary_time: string | null;           // HH:MM Bangkok, NULL = disabled
  attendance_summary_last_sent_date: string | null; // YYYY-MM-DD dedupe key
};

// Global (non-branch-scoped) configuration. Today it carries the
// IKIGAI OS LINE OA credentials + the shared cross-branch staff
// group ID, used to route PERSONA notifications (daily reports,
// edit requests, decisions) to a single group where staff from
// every branch can read them. Booking notifications continue to
// use the per-branch OA — see Q1 in the LINE OA design spec.
//
// Singleton — only one row, id always = 1.
export type SystemSettings = {
  id: 1;
  global_line_channel_token: string | null;
  global_staff_group_id: string | null;
  updated_at: string | null;
  updated_by: number | null;
};

// ── TC-A (Account management) types ──────────────────────────────

export type InviteKind = "onboard" | "reset" | "rebind_line";

export type Invite = {
  id: number;
  user_id: number;
  token: string;
  expires_at: string;
  used_at: string | null;
  created_by: number | null;
  created_at: string;
  kind: InviteKind;
};

export type EmergencyCredential = {
  id: number;
  user_id: number;
  temp_username: string;
  temp_password_hash: string;
  expires_at: string;
  used_at: string | null;
  created_by: number;
  created_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
};

export type ImpersonationLog = {
  id: number;
  impersonator_id: number;
  target_user_id: number;
  started_at: string;
  ended_at: string | null;
  reason: string | null;
  ip: string | null;
  user_agent: string | null;
};

// ── TC-P (Profile Phase A) types ─────────────────────────────────

export type Company = {
  id: number;
  name_th: string;
  name_en: string | null;
  tax_id: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  logo_url: string | null;
  active: number;
  created_at: string;
};

export type DisciplinarySeverity =
  | "verbal" | "written_1" | "written_2" | "final";

export type DisciplinaryWarning = {
  id: number;
  branch_id: number;
  user_id: number;
  issued_by_user_id: number;
  issued_at: string;
  severity: DisciplinarySeverity;
  title: string;
  body: string;
  reason_category: string | null;
  evidence_filename: string | null;
  effective_date: string | null;
  acknowledged_at: string | null;
  acknowledged_method: "pin_explicit" | "auto_on_leave" | null;
  auto_ack_reason: string | null;
  ref_no: string | null;
};

export type ShiftCode = {
  id: number;
  branch_id: number;
  code: string;
  name: string | null;
  start_time: string;       // HH:MM
  end_time: string;         // HH:MM
  break_start: string | null;
  break_end: string | null;
  color: string | null;
  display_order: number;
  active: number;
  created_at: string;
};

export type RosterPosition = {
  id: number;
  branch_id: number;
  title: string;
  description: string | null;
  display_order: number;
  active: number;
  created_at: string;
};

export type RosterAssignment = {
  id: number;
  branch_id: number;
  assignment_date: string;  // YYYY-MM-DD
  position_id: number;
  user_id: number;
  shift_code_id: number;
  created_by: number | null;
  created_at: string;
  updated_by: number | null;
  updated_at: string | null;
};

/** Account role hierarchy.
 *   super_admin — single, undeletable account ('admin' username).
 *                 Manages companies, system settings, role assignment,
 *                 and impersonates other accounts for debugging.
 *   admin       — branch operator. Approves leave / discipline /
 *                 resignation, manages roster, sees PERSONA dashboards.
 *                 Promoted by super_admin only.
 *   staff       — base level. /staff/* only. */
export type UserRole = "super_admin" | "admin" | "staff";

export type User = {
  id: number;
  username: string;
  password_hash: string;
  display_name: string;
  role: UserRole;
};

/** Full Phase A employee profile row — superset of `User` with all
 *  the empeo-equivalent personal, contact and employment fields the
 *  admin edit modal and the staff self-edit page work with. Kept as
 *  a separate type so existing User consumers stay lean; views that
 *  need the rich profile cast to this. */
export type EmployeeProfile = {
  // Identity (from users table, same shape as User)
  id: number;
  username: string;
  display_name: string;
  role: UserRole;
  status: "active" | "pending_invite" | "disabled";
  // Personal
  title_prefix: string | null;
  first_name_th: string | null;
  last_name_th: string | null;
  first_name_en: string | null;
  last_name_en: string | null;
  nickname_th: string | null;
  nickname_en: string | null;
  dob: string | null;
  gender: "male" | "female" | null;
  nationality: string | null;
  race: string | null;
  religion: string | null;
  marital_status: string | null;
  military_status: string | null;
  blood_type: string | null;
  height_cm: number | null;
  weight_kg: number | null;
  personal_notes: string | null;
  national_id: string | null;
  // Contact
  personal_email: string | null;
  corporate_email: string | null;
  mobile_phone: string | null;
  work_phone: string | null;
  line_id: string | null;
  line_user_id: string | null;
  house_address: string | null;
  house_subdistrict: string | null;
  house_district: string | null;
  house_province: string | null;
  house_postcode: string | null;
  contact_address: string | null;
  contact_subdistrict: string | null;
  contact_district: string | null;
  contact_province: string | null;
  contact_postcode: string | null;
  contact_same_as_house: number;
  emergency_name: string | null;
  emergency_relationship: string | null;
  emergency_phone: string | null;
  // Employment
  supervisor_user_id: number | null;
  job_title: string | null;
  hire_date: string | null;
  contract_end_date: string | null;
  employment_status: "probation" | "permanent" | null;
  employment_type: "pt" | "ft" | null;
  track_attendance: number;
  hire_mode: "monthly" | "daily" | "hourly" | null;
  payment_method: "bank" | "cash" | null;
  driver_license_no: string | null;
  manpower_type: "new" | "replacement" | null;
  profile_self_edit_open: number;
  // Salary (already present)
  hourly_rate: number | null;
  monthly_salary: number | null;
  pay_cycle: "weekly" | "monthly" | null;
  salary_tax_mode: "sso" | "wht" | null;
  // Banking (already present)
  bank_name: string | null;
  bank_account: string | null;
  tax_id: string | null;
  sso_id: string | null;
  employee_code: string | null;
  // Shift / weekly off (already present, included for one-stop access)
  shift_start_time: string | null;
  weekly_off_days: string | null;
};

export type TableRow = {
  id: number;
  branch_id: number;
  zone_id: number | null;
  label: string;
  capacity: number;
  shape: "rect" | "round";
  x: number;
  y: number;
  width: number;
  height: number;
  active: number;
};

export type Zone = {
  id: number;
  branch_id: number;
  name: string;
  description: string | null;
  display_order: number;
  active: number;
  availability_rules: string | null;   // JSON (Sprint 3); null = always open within branch hours
  created_at: string;
  updated_at: string;
};

export type BookingStatus =
  | "pending_review"   // customer submitted but admin hasn't picked a table / confirmed yet
  | "confirmed"
  | "seated"
  | "no_show"
  | "cancelled"
  | "completed";

export type Booking = {
  id: number;
  branch_id: number;
  table_id: number | null;
  customer_name: string;
  customer_phone: string;
  party_size: number;
  source: string | null;
  customer_origin: string | null;     // sriracha | chonburi | other_province | null
  is_member: number | null;           // 1 / 0 / null
  lang: string | null;                // 'th' | 'en' | null (= legacy / unknown)
  booking_channel: string | null;     // 'online' | 'phone' | 'walkin' | null (= legacy)
  ref_no: string | null;              // 'R20260500001' — public reference shown on QR / Flex
  booking_date: string;
  booking_time: string;
  duration_minutes: number;
  status: BookingStatus;
  notes: string | null;
  line_user_id: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  seated_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;       // shown to customer in cancellation Flex card
  food_allergy: string | null;        // dietary restrictions / allergies (free text)
};

// ── PERSONA: shift handover + readiness reports ──────────────────────
export type DailyReportType =
  | "shift_open"      // เปิดกะ (yesterday closing + drawer + 6-item checklist)
  | "shift_close"     // ปิดกะ (POS / EDC / expenses / OT / closing drawer)
  | "readiness_1130"  // รายงานความพร้อม รอบ 11:30
  | "readiness_1600"; // รายงานความพร้อม รอบ 16:00

export type DailyReport = {
  id: number;
  type: DailyReportType;
  branch_id: number;
  user_id: number;
  report_date: string;     // YYYY-MM-DD
  data: string;            // JSON of form fields
  created_at: string;
  updated_at: string;
};

export type ShiftChecklistItem = {
  id: number;
  type: "shift_open" | "shift_close";
  /** Per-branch since 2026-05 — admin manages each branch's list independently. */
  branch_id: number;
  label: string;
  display_order: number;
  active: number;          // 1 / 0
  created_at: string;
};
