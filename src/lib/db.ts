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

export type User = {
  id: number;
  username: string;
  password_hash: string;
  display_name: string;
  role: "admin" | "staff";
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
