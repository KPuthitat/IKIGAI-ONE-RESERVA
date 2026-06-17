import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { encryptSecret } from "./secret-vault";

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

  // Special occasion (added 2026-05-22) — drives the personalised
  // LINE reply customer gets after submitting (and the staff Flex
  // card shows it so the team can prepare e.g. a birthday plate).
  // One of a fixed enum (see OCCASION_KINDS) or NULL = customer
  // didn't specify. Free-text 'notes' still exists for everything
  // that doesn't fit one of the buckets.
  if (!bnames.has("occasion")) {
    db.exec("ALTER TABLE bookings ADD COLUMN occasion TEXT");
  }

  // Verification + redemption (added 2026-05-24) — the QR shown on
  // the LINE confirm card. Staff scans on arrival; the code is the
  // single identifier behind the QR + the human-readable fallback
  // ("X4F2K9" prints under the QR so the customer can read it aloud
  // if scanning fails).
  //   verification_code     — 6-char A-Z0-9 (no 0/O/1/I to avoid
  //                            misread). NULL on legacy rows.
  //   redemption_status     — eligible | claimed | expired | not_eligible
  //                            "not_eligible" = returning customer
  //                            (matched on phone). "expired" set by
  //                            cron 6 hours after booking_time.
  //   redeemed_at / by      — set when staff clicks "เคลมไอติม".
  if (!bnames.has("verification_code")) {
    db.exec("ALTER TABLE bookings ADD COLUMN verification_code TEXT");
  }
  if (!bnames.has("redemption_status")) {
    db.exec("ALTER TABLE bookings ADD COLUMN redemption_status TEXT");
  }
  if (!bnames.has("redeemed_at")) {
    db.exec("ALTER TABLE bookings ADD COLUMN redeemed_at TEXT");
  }
  if (!bnames.has("redeemed_by_user_id")) {
    db.exec("ALTER TABLE bookings ADD COLUMN redeemed_by_user_id INTEGER REFERENCES users(id)");
  }
  // Code lookup index — staff scans → ID by code. Sparse since most
  // legacy rows are NULL.
  db.exec("CREATE INDEX IF NOT EXISTS idx_bookings_verification_code ON bookings(verification_code) WHERE verification_code IS NOT NULL");

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

  // Phone format backfill (added 2026-05) — strip dashes / spaces /
  // parens from existing customer_phone values so the column stores
  // a single canonical format (digits + leading "+" only). New rows
  // go in pre-normalised via the API routes. Idempotent: the WHERE
  // clause skips already-clean values so this is essentially free
  // after the first run.
  db.exec(`
    UPDATE bookings
    SET customer_phone = REPLACE(REPLACE(REPLACE(REPLACE(customer_phone, ' ', ''), '-', ''), '(', ''), ')', '')
    WHERE customer_phone IS NOT NULL
      AND (customer_phone LIKE '% %'
        OR customer_phone LIKE '%-%'
        OR customer_phone LIKE '%(%'
        OR customer_phone LIKE '%)%')
  `);

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
  // 2026-05-21: per-item `kind` so admin can mark an entry as a
  // free-text box (kind='text') instead of the default check-yes/no
  // (kind='checkbox'). Staff forms branch on this. Legacy rows default
  // to 'checkbox' so the system behaves identically pre-migration.
  if (!sccolNames.has("kind")) {
    db.exec("ALTER TABLE shift_checklist_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'checkbox'");
  }
  // 2026-05-21: kind='choice' adds a multi-option radio. Admin types
  // the options in the editor; staff sees pill buttons (one selected
  // at a time). Stored as a JSON array of strings, null when kind ≠
  // 'choice'. Default NULL so legacy text/checkbox rows stay unchanged.
  if (!sccolNames.has("options_json")) {
    db.exec("ALTER TABLE shift_checklist_items ADD COLUMN options_json TEXT");
  }
  // 2026-05-21: parent_id enables 2-level nesting — a parent row (e.g.
  // "ยอดรวม POS") + child rows (e.g. "Cash", "PromptPay", ...). Only
  // 2 levels deep: a row whose parent_id IS NOT NULL cannot itself be
  // a parent. Enforced at the API + UI layers. NULL = top-level row
  // (matches legacy data).
  //
  // ON DELETE CASCADE so deleting a parent cleans up its children
  // automatically. Same self-referential pattern as several other
  // tables in the schema.
  if (!sccolNames.has("parent_id")) {
    db.exec("ALTER TABLE shift_checklist_items ADD COLUMN parent_id INTEGER REFERENCES shift_checklist_items(id) ON DELETE CASCADE");
  }
  // 2026-05-21: is_headline_amount flags an amount-kind item to be
  // featured prominently above the checklist body on the LINE Flex
  // card. Originally one-per-(branch,type) but admin wanted multiple
  // (e.g. ยอดขายวันนี้ + ยอดเงินปิดกะ both featured); the constraint
  // was dropped 2026-05-21 evening — flagged rows now stack ordered
  // by display_order, with the first one rendering biggest. The flag
  // is meaningful only when kind='amount'.
  if (!sccolNames.has("is_headline_amount")) {
    db.exec("ALTER TABLE shift_checklist_items ADD COLUMN is_headline_amount INTEGER NOT NULL DEFAULT 0");
  }
  // 2026-05-21: description is optional small-text help shown under
  // the label on the staff form + LINE Flex card. Admin uses it for
  // examples / clarifications (e.g. "ค่าเหล้า เลม่อน ผงกาแฟ...") so
  // long-form context doesn't have to live in the label text.
  if (!sccolNames.has("description")) {
    db.exec("ALTER TABLE shift_checklist_items ADD COLUMN description TEXT");
  }
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

  // 2026-05-21: readiness_1130 + readiness_1600 used to be 3 hardcoded
  // textareas + 1 alcohol radio. Refactored to be fully admin-driven —
  // seed the equivalent items per branch so existing behaviour is
  // preserved out-of-the-box. Branches whose admins have already added
  // any readiness items are left alone (cnt > 0 means they've already
  // customized; don't overwrite). The alcohol item uses kind='choice'
  // with 2 options to keep the same UX as the old radio.
  const seedInsRich = db.prepare(
    "INSERT INTO shift_checklist_items (type, label, display_order, branch_id, kind, options_json) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const READINESS_DEFAULTS: Array<{
    label: string; kind: "text" | "choice"; options?: string[];
  }> = [
    { label: "เรื่องที่อยากสื่อสารในทีม", kind: "text" },
    { label: "เมนูที่ไม่พร้อมขาย", kind: "text" },
    { label: "เมนูที่ขายได้ แต่มีการปรับบางอย่าง", kind: "text" },
    { label: "สถานะการขายแอลกอฮอล์ในวันนี้", kind: "choice", options: ["ขายได้ปกติ", "ห้ามขาย"] }
  ];
  for (const b of allBranches) {
    for (const readinessType of ["readiness_1130", "readiness_1600"] as const) {
      const cnt = db.prepare(
        "SELECT COUNT(*) AS n FROM shift_checklist_items WHERE type = ? AND branch_id = ?"
      ).get(readinessType, b.id) as { n: number };
      if (cnt.n === 0) {
        for (let i = 0; i < READINESS_DEFAULTS.length; i++) {
          const d = READINESS_DEFAULTS[i];
          seedInsRich.run(
            readinessType, d.label, (i + 1) * 10, b.id,
            d.kind, d.options ? JSON.stringify(d.options) : null
          );
        }
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
      action TEXT NOT NULL CHECK (action IN ('delete','edit','create','cert-approve','cert-reject')),
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

  // ot_requests — overtime requests (owner 2026-06-03). When a PT staff
  // clocks out AFTER their scheduled shift end, น้องฮูก asks whether they
  // had pre-approved OT; if yes they enter the time they requested to
  // work until. A supervisor/admin must APPROVE before it counts toward
  // pay. The pay engine then credits OT = min(actual clock-out,
  // requested_until) − scheduled end (only when approved). One request
  // per (user, day) — re-submitting updates it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ot_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      branch_id INTEGER REFERENCES branches(id),
      work_date TEXT NOT NULL,          -- YYYY-MM-DD (BKK)
      requested_until TEXT NOT NULL,    -- 'HH:MM' (BKK local)
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected')),
      decided_by INTEGER REFERENCES users(id),
      decided_at TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, work_date)
    );
    CREATE INDEX IF NOT EXISTS idx_ot_requests_status ON ot_requests(status, work_date);
    CREATE INDEX IF NOT EXISTS idx_ot_requests_user_date ON ot_requests(user_id, work_date);
  `);

  // shift_change_requests — staff ask to ADD a working day (PT wanting an
  // extra shift) or SWAP a day off for another (FT taking a day off
  // without spending leave, by working a different day). v1 (owner
  // 2026-06-05): record + notify only — approval does NOT touch the
  // roster or the pay engine; an admin reflects it in the roster
  // manually. kind='extra_shift' → only work_date; kind='swap' →
  // work_date (the day worked instead) + off_date (the day taken off).
  db.exec(`
    CREATE TABLE IF NOT EXISTS shift_change_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      branch_id INTEGER REFERENCES branches(id),
      kind TEXT NOT NULL CHECK (kind IN ('extra_shift','swap')),
      work_date TEXT NOT NULL,          -- YYYY-MM-DD (BKK) — day to ADD work
      off_date TEXT,                    -- swap only — day taken off in exchange
      note TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected','cancelled')),
      ref_no TEXT,
      decided_by INTEGER REFERENCES users(id),
      decided_at TEXT,
      decision_note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_shiftreq_user_status ON shift_change_requests(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_shiftreq_branch_status ON shift_change_requests(branch_id, status, work_date);
  `);

  // Phase 1C v2 migrations — extend users + leave_requests
  const ucols2 = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  const unames = new Set(ucols2.map((c) => c.name));
  if (!unames.has("gender")) db.exec("ALTER TABLE users ADD COLUMN gender TEXT"); // 'male'|'female'|null
  if (!unames.has("employment_type")) db.exec("ALTER TABLE users ADD COLUMN employment_type TEXT"); // 'pt'|'ft'|null

  // Chain-of-command for approvals (added 2026-05). Owner direction:
  // staff requests (leave / resignation / future approvals) route to
  // a direct manager first; if they don't decide within
  // escalation_hours, the request escalates up the chain to the
  // manager's manager, eventually super_admin.
  //   reports_to_user_id  — direct manager. NULL = top of chain
  //                          (super_admin is the implicit ceiling).
  //   escalation_hours    — how long this user's queue may sit
  //                          before the request escalates. NULL =
  //                          use SYSTEM default (24h).
  if (!unames.has("reports_to_user_id")) {
    db.exec("ALTER TABLE users ADD COLUMN reports_to_user_id INTEGER REFERENCES users(id)");
  }
  if (!unames.has("escalation_hours")) {
    db.exec("ALTER TABLE users ADD COLUMN escalation_hours INTEGER");
  }

  const lrcols = db.prepare("PRAGMA table_info(leave_requests)").all() as Array<{ name: string }>;
  const lnames = new Set(lrcols.map((c) => c.name));
  if (!lnames.has("hours")) db.exec("ALTER TABLE leave_requests ADD COLUMN hours REAL"); // null = full day(s)
  if (!lnames.has("evidence_filename")) db.exec("ALTER TABLE leave_requests ADD COLUMN evidence_filename TEXT");
  if (!lnames.has("created_by")) db.exec("ALTER TABLE leave_requests ADD COLUMN created_by INTEGER REFERENCES users(id)");
  // Phase 1C v4: special-track flag (ต้องอนุมัติพิเศษโดยผู้บริหาร)
  if (!lnames.has("is_special_request")) db.exec("ALTER TABLE leave_requests ADD COLUMN is_special_request INTEGER NOT NULL DEFAULT 0");
  // Phase 1C v9: replaces_id — ลิงก์คำขอใหม่ที่แก้แล้วกลับไปยังคำขอเดิม
  if (!lnames.has("replaces_id")) db.exec("ALTER TABLE leave_requests ADD COLUMN replaces_id INTEGER");

  // Chain-of-command tracking (added 2026-05). The leave request is
  // assigned to a specific approver at creation time (the requester's
  // reports_to_user_id, falling back to super_admin). When that
  // approver doesn't decide within their escalation_hours, the cron
  // sweeper reassigns to THEIR manager and bumps escalated_to_level.
  // history_json keeps the full audit trail of who saw it when.
  //   current_approver_user_id  — who needs to action this NOW.
  //                                Null = nobody assigned yet (legacy).
  //   escalated_to_level         — 0 = first assignee, 1 = first
  //                                 escalation up the chain, etc.
  //   last_escalated_at          — ISO ts of the most recent
  //                                 reassignment (used by the cron
  //                                 sweep + LINE timer display).
  //   approval_history           — JSON array of
  //                                 [{user_id, assigned_at, level}].
  if (!lnames.has("current_approver_user_id")) {
    db.exec("ALTER TABLE leave_requests ADD COLUMN current_approver_user_id INTEGER REFERENCES users(id)");
  }
  if (!lnames.has("escalated_to_level")) {
    db.exec("ALTER TABLE leave_requests ADD COLUMN escalated_to_level INTEGER NOT NULL DEFAULT 0");
  }
  if (!lnames.has("last_escalated_at")) {
    db.exec("ALTER TABLE leave_requests ADD COLUMN last_escalated_at TEXT");
  }
  if (!lnames.has("approval_history")) {
    db.exec("ALTER TABLE leave_requests ADD COLUMN approval_history TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_leave_approver_pending ON leave_requests(current_approver_user_id, status)");

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
    ["military",      60,   "male",   "all", 0, 1, 8],
    // ลาไม่รับค่าจ้าง (owner 2026-06-17): no quota; the day is deducted at
    // salary/30 even for FT. Label lives in line.ts; payroll deduction in
    // payroll-compute.ts (unpaidLeaveDays). No evidence/pre-approval gate.
    ["unpaid",        null, "all",    "all", 0, 0, 9]
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
  // 2026-06-03: pt_special — owner rule. PT staff don't get traditional
  // public holidays; instead the company designates ~13 "วันพิเศษ" a
  // year that pay PT at the 1.5× special rate. These are SEPARATE from
  // public holidays (which are now info-only: "วันลูกค้าเยอะ"). The PT
  // premium reads ONLY pt_special=1; a date can be a public holiday,
  // a pt_special day, both, or neither.
  if (!phcols.some((c) => c.name === "pt_special")) {
    db.exec("ALTER TABLE public_holidays ADD COLUMN pt_special INTEGER NOT NULL DEFAULT 0");
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
  // 2026-05-30 — shift_close default-field highlight toggles. Three
  // money fields (closing drawer, service charge, daily revenue) are
  // baked into the post-shift summary card. Until now they were ALL
  // forced into the red headline box regardless, which made the card
  // look cluttered and gave admin no way to emphasise the one number
  // that actually matters for their branch ("ยอดขาย is the KPI for
  // NAMA; ยอดเงินปิดงาน for HYPOPLARAEMIA").
  //
  // Each column: 1 = include in the red headline box; 0 = fall
  // through to the normal checklist body where the row renders bold
  // (kind='amount') but without the dramatic background.
  //
  // Default 1 across the board preserves existing behaviour for any
  // branch that hasn't touched the new settings yet.
  if (!bnames2.has("sc_show_drawer_primary")) {
    db.exec("ALTER TABLE branches ADD COLUMN sc_show_drawer_primary INTEGER NOT NULL DEFAULT 1");
  }
  if (!bnames2.has("sc_show_svc_primary")) {
    db.exec("ALTER TABLE branches ADD COLUMN sc_show_svc_primary INTEGER NOT NULL DEFAULT 1");
  }
  if (!bnames2.has("sc_show_revenue_primary")) {
    db.exec("ALTER TABLE branches ADD COLUMN sc_show_revenue_primary INTEGER NOT NULL DEFAULT 1");
  }
  // 2026-05-30 — extend the 3 default fields with custom label +
  // display order. NULL label = fall back to the hardcoded default
  // ("ยอดเงินปิดงาน" / "เซอร์วิสชาร์จวันนี้" / "ยอดขายวันนี้").
  // Display order is a small positive int: lower = renders first.
  // Defaults preserve the legacy 1 → 2 → 3 sequence so existing
  // branches see no visible change until they reorder.
  if (!bnames2.has("sc_drawer_label")) {
    db.exec("ALTER TABLE branches ADD COLUMN sc_drawer_label TEXT");
  }
  if (!bnames2.has("sc_svc_label")) {
    db.exec("ALTER TABLE branches ADD COLUMN sc_svc_label TEXT");
  }
  if (!bnames2.has("sc_revenue_label")) {
    db.exec("ALTER TABLE branches ADD COLUMN sc_revenue_label TEXT");
  }
  if (!bnames2.has("sc_drawer_order")) {
    db.exec("ALTER TABLE branches ADD COLUMN sc_drawer_order INTEGER NOT NULL DEFAULT 1");
  }
  if (!bnames2.has("sc_svc_order")) {
    db.exec("ALTER TABLE branches ADD COLUMN sc_svc_order INTEGER NOT NULL DEFAULT 2");
  }
  if (!bnames2.has("sc_revenue_order")) {
    db.exec("ALTER TABLE branches ADD COLUMN sc_revenue_order INTEGER NOT NULL DEFAULT 3");
  }
  // Fallback contact phone — shown to the customer in the "request received,
  // awaiting confirmation" LINE message so they have a way to follow up if
  // admin doesn't get to their pending booking. Optional; if unset the
  // pending message just omits the phone line.
  if (!bnames2.has("contact_phone")) {
    db.exec("ALTER TABLE branches ADD COLUMN contact_phone TEXT");
  }
  // Customer LINE OA URL (added 2026-05) — admin pastes the branch's
  // public LINE "add friend" URL (https://line.me/R/ti/p/@xxx). The
  // customer branch picker (/reserva) opens this URL instead of
  // /reserva/<slug> when set, so customers always reach the OA
  // BEFORE the booking form. The OA's rich menu then deep-links
  // back into the booking form. NULL = fall back to the direct
  // booking link (legacy behaviour).
  if (!bnames2.has("customer_line_oa_url")) {
    db.exec("ALTER TABLE branches ADD COLUMN customer_line_oa_url TEXT");
  }
  // Cross-branch promotion matrix (added 2026-05). When a customer
  // visits /reserva?from=<thisBranchSlug>, the picker only shows the
  // OTHER branches the admin of <thisBranch> has enabled here, using
  // the URLs the admin has typed. Stored as JSON because the matrix
  // is tiny (4 branches × 4 entries = 16 rows max company-wide) and
  // we never query it relationally.
  //
  // Shape: Array<{ target_slug: string; url: string | null; enabled: boolean }>
  // NULL or empty array = no cross-promotions; the picker without
  // ?from still shows every branch with its own customer_line_oa_url
  // (legacy behaviour preserved).
  if (!bnames2.has("cross_promotions")) {
    db.exec("ALTER TABLE branches ADD COLUMN cross_promotions TEXT");
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
  // Per-branch notification audience toggles — admin can mute any
  // (event × audience) combo from the messaging settings card. Defaults
  // mirror the prior hardcoded behaviour, EXCEPT staff_reminder which
  // defaults OFF: the "ใกล้ถึงเวลาจอง" reminder in the staff group is
  // pure noise (customers already get reminded directly), and it was
  // the first toggle admin asked for.
  if (!bnames2.has("notify_customer_pending")) {
    db.exec("ALTER TABLE branches ADD COLUMN notify_customer_pending INTEGER NOT NULL DEFAULT 1");
  }
  if (!bnames2.has("notify_customer_created")) {
    db.exec("ALTER TABLE branches ADD COLUMN notify_customer_created INTEGER NOT NULL DEFAULT 1");
  }
  if (!bnames2.has("notify_customer_reminder")) {
    db.exec("ALTER TABLE branches ADD COLUMN notify_customer_reminder INTEGER NOT NULL DEFAULT 1");
  }
  if (!bnames2.has("notify_staff_pending")) {
    db.exec("ALTER TABLE branches ADD COLUMN notify_staff_pending INTEGER NOT NULL DEFAULT 1");
  }
  if (!bnames2.has("notify_staff_created")) {
    db.exec("ALTER TABLE branches ADD COLUMN notify_staff_created INTEGER NOT NULL DEFAULT 1");
  }
  if (!bnames2.has("notify_staff_reminder")) {
    db.exec("ALTER TABLE branches ADD COLUMN notify_staff_reminder INTEGER NOT NULL DEFAULT 0");
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

  // Service-charge required-on-close-shift flag (added 2026-05-23).
  // When ON, the shift_close form shows a mandatory "ยอดเซอร์วิสชาร์จ
  // วันนี้" field that feeds the staff-share calculator at
  // /admin/persona/service-charge. When OFF (default), the field is
  // hidden and admin fills the value back-office at month-end.
  // Replaces the old always-shown closing_drawer + service_charge
  // fields — closing-drawer is now an admin-configurable checklist
  // item (admin owns the schema), and service-charge stays top-level
  // because it has a hard downstream consumer (the calculator).
  if (!bnames2.has("require_service_charge")) {
    db.exec("ALTER TABLE branches ADD COLUMN require_service_charge INTEGER NOT NULL DEFAULT 0");
  }

  // Required-financial-checklist toggles (added 2026-05). Owner direction:
  // bring the 4 amount fields back to the top of every shift report
  // as mandatory per-branch checklists, with an admin toggle to turn
  // each off when not relevant. Other free-form checklist items go
  // below these.
  //   require_yesterday_closing — shift_open: "ยอดเงินปิดกะเมื่อวาน"
  //   require_morning_opening   — shift_open: "ยอดเงินเปิดกะเช้านี้"
  //   require_today_closing     — shift_close: "ยอดเงินปิดกะวันนี้"
  // DEFAULT 1 so every existing branch picks them up immediately;
  // admin can flip off per branch.
  if (!bnames2.has("require_yesterday_closing")) {
    db.exec("ALTER TABLE branches ADD COLUMN require_yesterday_closing INTEGER NOT NULL DEFAULT 1");
  }
  if (!bnames2.has("require_morning_opening")) {
    db.exec("ALTER TABLE branches ADD COLUMN require_morning_opening INTEGER NOT NULL DEFAULT 1");
  }
  if (!bnames2.has("require_today_closing")) {
    db.exec("ALTER TABLE branches ADD COLUMN require_today_closing INTEGER NOT NULL DEFAULT 1");
  }
  // require_daily_revenue (2026-05-28) — toggles the "ยอดขายวันนี้"
  // field on the shift_close form. DEFAULT 1 so every branch picks it
  // up immediately. Feeds branch_daily_revenue (ASCENDA COL %, sales
  // growth) AND now appears as a headline figure at the top of the
  // shift-close report flex card so admins reading the LINE group see
  // the headline numbers (closing/SVC/revenue) at a glance.
  if (!bnames2.has("require_daily_revenue")) {
    db.exec("ALTER TABLE branches ADD COLUMN require_daily_revenue INTEGER NOT NULL DEFAULT 1");
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
  // One-time default backfill (2026-05-24): owner reported the auto
  // attendance summary never landed in the executive group. Root
  // cause was attendance_summary_time being NULL on every existing
  // branch (admin needed to set it manually but the UI for that was
  // only added later). Backfill any branch still on NULL to "11:00"
  // so the feature works out-of-the-box. Idempotent — sets only when
  // currently NULL; admin's later changes stick.
  db.exec(`
    UPDATE branches
    SET attendance_summary_time = '11:00'
    WHERE attendance_summary_time IS NULL
      AND status = 'open'
  `);

  // Per-shift personal LINE reminder: each morning at
  // shift_notify_time the cron DMs every staff member who has a
  // roster assignment that day (to their users.line_user_id) with
  // their shift time + position. shift_notify_last_sent_date is the
  // same-day dedupe key (mirrors attendance_summary_*).
  //   NULL shift_notify_time = auto-send disabled (manual button
  //   still works from the roster page).
  if (!bnames2.has("shift_notify_time")) {
    db.exec("ALTER TABLE branches ADD COLUMN shift_notify_time TEXT");
  }
  if (!bnames2.has("shift_notify_last_sent_date")) {
    db.exec("ALTER TABLE branches ADD COLUMN shift_notify_last_sent_date TEXT");
  }

  // Daily pending-requests digest (owner 2026-06-05). Once per day per
  // branch, at pending_digest_time, push a single LINE card to the
  // executive/HR group summarising staff requests that are still
  // waiting on someone: shift-change requests (คำขอเปลี่ยนเวลางาน) and
  // pending leave (คำขอลางานรออนุมัติ). Catches requests that "fell
  // through" — nobody actioned them. pending_digest_last_sent_date is
  // the same-day dedupe key (mirrors attendance_summary_*).
  //   NULL pending_digest_time = digest disabled for that branch.
  if (!bnames2.has("pending_digest_time")) {
    db.exec("ALTER TABLE branches ADD COLUMN pending_digest_time TEXT");
  }
  if (!bnames2.has("pending_digest_last_sent_date")) {
    db.exec("ALTER TABLE branches ADD COLUMN pending_digest_last_sent_date TEXT");
  }

  // Multiple daily attendance summaries (owner 2026-06-06): admin can
  // configure more than one send time per day (e.g., 08:30 and 17:00).
  // attendance_summary_times_json stores a JSON array of HH:MM strings
  // (e.g., ["08:30","17:00"]). When set, supersedes the legacy single
  // attendance_summary_time. attendance_summary_sent_log tracks which
  // times were already sent today so cron ticks don't re-send:
  //   {"date":"YYYY-MM-DD","sent":["08:30"]}
  // All attendance summary notifications route to the HR group
  // (recruita_exec_group_id) instead of the global exec group.
  if (!bnames2.has("attendance_summary_times_json")) {
    db.exec("ALTER TABLE branches ADD COLUMN attendance_summary_times_json TEXT");
  }
  if (!bnames2.has("attendance_summary_sent_log")) {
    db.exec("ALTER TABLE branches ADD COLUMN attendance_summary_sent_log TEXT");
  }

  // Per-branch INVENTA LINE group (owner 2026-06-06). Stock notifications
  // (PO approval, expiry alerts) should go to the clinic's own group, not
  // the shared cross-branch group. NULL = fall back to the global group.
  if (!bnames2.has("inventa_group_id")) {
    db.exec("ALTER TABLE branches ADD COLUMN inventa_group_id TEXT");
  }
  // Optional display label for the INVENTA group (shown in settings UI).
  if (!bnames2.has("inventa_group_name")) {
    db.exec("ALTER TABLE branches ADD COLUMN inventa_group_name TEXT");
  }
  // INVENTA label print size in mm (owner 2026-06-08). Default 80×50 mm —
  // the common thermal sticker. Configurable in INVENTA settings; the
  // labels page sizes each printed sticker + the @page to these values.
  if (!bnames2.has("inventa_label_width_mm")) {
    db.exec("ALTER TABLE branches ADD COLUMN inventa_label_width_mm INTEGER NOT NULL DEFAULT 80");
  }
  if (!bnames2.has("inventa_label_height_mm")) {
    db.exec("ALTER TABLE branches ADD COLUMN inventa_label_height_mm INTEGER NOT NULL DEFAULT 50");
  }
  // INVENTA label LAYOUT (owner 2026-06-09): per-branch drag-designed
  // element positions/sizes/visibility, stored as JSON. NULL = use the
  // built-in default layout (so existing branches print unchanged).
  if (!bnames2.has("inventa_label_layout")) {
    db.exec("ALTER TABLE branches ADD COLUMN inventa_label_layout TEXT");
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

  // Widen time_certifications for MISSING-PUNCH requests (owner 2026-06-08):
  // a staff who forgot to clock in/out has no time_entries row to certify,
  // so entry_id becomes nullable and new columns describe the punch to
  // CREATE on approval (kind='missing', entry_type in/out, work_date,
  // branch_id). SQLite can't drop NOT NULL via ALTER → rebuild. Safe
  // pattern: FK OFF around the swap (it has FKs out to time_entries/users/
  // branches; no incoming FK so the drop is harmless). Idempotent.
  {
    const certSql = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='time_certifications'"
    ).get() as { sql: string } | undefined)?.sql ?? "";
    if (certSql && !certSql.includes("'missing'")) {
      db.exec("PRAGMA foreign_keys = OFF");
      try {
        db.transaction(() => {
          db.exec(`
            CREATE TABLE time_certifications_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              entry_id INTEGER REFERENCES time_entries(id) ON DELETE CASCADE,
              requested_by INTEGER NOT NULL REFERENCES users(id),
              reason TEXT NOT NULL,
              proposed_ts TEXT NOT NULL,
              original_ts TEXT,
              kind TEXT NOT NULL DEFAULT 'correction'
                CHECK (kind IN ('correction','missing')),
              entry_type TEXT CHECK (entry_type IN ('in','out')),
              work_date TEXT,
              branch_id INTEGER REFERENCES branches(id),
              status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected')),
              decided_by INTEGER REFERENCES users(id),
              decided_at TEXT,
              decision_note TEXT,
              created_at TEXT NOT NULL
            );
            INSERT INTO time_certifications_new
              (id, entry_id, requested_by, reason, proposed_ts, original_ts,
               kind, status, decided_by, decided_at, decision_note, created_at)
              SELECT id, entry_id, requested_by, reason, proposed_ts, original_ts,
                     'correction', status, decided_by, decided_at, decision_note, created_at
              FROM time_certifications;
            DROP TABLE time_certifications;
            ALTER TABLE time_certifications_new RENAME TO time_certifications;
            CREATE INDEX IF NOT EXISTS idx_time_cert_pending_branch
              ON time_certifications(status, entry_id) WHERE status = 'pending';
          `);
        })();
      } finally {
        db.exec("PRAGMA foreign_keys = ON");
      }
    }
  }

  // ── REPAIR: approved missing-punch certs that never created an entry ──
  // (owner 2026-06-11, reported repeatedly: ฐิติรัตน์ + อนุธิดา 05/06 รับรอง
  // เวลาออกแล้วแต่ "ไม่มีสักที่เลย"). Earlier builds marked a missing-punch
  // cert 'approved' WITHOUT inserting the time_entries row it described —
  // so the punch shows nowhere (timesheet, payroll) and, being approved,
  // is no longer pending to re-process. Past deploys fixed the FORWARD
  // path (decide route now creates the entry) but never repaired the rows
  // already stuck in that state. This backfills them once.
  //
  // Safe + idempotent:
  //   • Only approved 'missing' certs with entry_id IS NULL (untouched rows).
  //   • Dedups against an identical existing punch (same user/type/ts) so a
  //     half-repaired row can't double-insert.
  //   • Links the cert to the entry → entry_id no longer NULL → never repeats.
  // After deploy the punch appears in the timesheet; the owner recomputes
  // the covering payroll period (one click) so ค่าตอบแทน picks it up.
  {
    const certCols = (db.prepare("PRAGMA table_info(time_certifications)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    if (certCols.includes("kind") && certCols.includes("entry_type")) {
      const stuck = db.prepare(`
        SELECT id, requested_by, entry_type, proposed_ts, branch_id,
               COALESCE(decided_by, requested_by) AS actor_id
        FROM time_certifications
        WHERE kind = 'missing' AND status = 'approved' AND entry_id IS NULL
          AND entry_type IN ('in','out') AND proposed_ts IS NOT NULL
      `).all() as Array<{
        id: number; requested_by: number; entry_type: "in" | "out";
        proposed_ts: string; branch_id: number | null; actor_id: number;
      }>;
      if (stuck.length > 0) {
        const findEntry = db.prepare(
          "SELECT id FROM time_entries WHERE user_id = ? AND type = ? AND ts = ? LIMIT 1"
        );
        const insEntry = db.prepare(
          "INSERT INTO time_entries (user_id, type, ts, branch_id) VALUES (?, ?, ?, ?)"
        );
        const insAudit = db.prepare(`
          INSERT INTO time_entries_audit
            (entry_id, entry_user_id, entry_type, entry_ts, action, admin_id, reason, created_at)
          VALUES (?, ?, ?, ?, 'create', ?, ?, ?)
        `);
        const linkCert = db.prepare("UPDATE time_certifications SET entry_id = ? WHERE id = ?");
        const nowIso = new Date().toISOString();
        const repairTx = db.transaction(() => {
          for (const c of stuck) {
            const existing = findEntry.get(c.requested_by, c.entry_type, c.proposed_ts) as
              | { id: number } | undefined;
            let entryId: number;
            if (existing) {
              entryId = existing.id;
            } else {
              const r = insEntry.run(c.requested_by, c.entry_type, c.proposed_ts, c.branch_id);
              entryId = Number(r.lastInsertRowid);
              insAudit.run(
                entryId, c.requested_by, c.entry_type, c.proposed_ts, c.actor_id,
                `ซ่อมย้อนหลัง: cert#${c.id} อนุมัติแล้วแต่ยังไม่ได้สร้างรายการเวลา (2026-06-11)`,
                nowIso
              );
            }
            linkCert.run(entryId, c.id);
          }
        });
        repairTx();
        console.info(`[time-cert] repaired ${stuck.length} approved missing cert(s) with no entry`);
      }
    }
  }

  // ── attendance_flags — lightweight "irregular time-logging" history ──
  // (owner 2026-06-08). When a staff forgets to clock in/out (or, later,
  // clocks against a swapped shift), น้องฮูก records a flag here as a
  // gentle HISTORY entry — NOT a disciplinary_warnings row. The owner
  // chose: "แค่แจ้งเตือนว่ามีพฤติกรรมการลงเวลาผิดปกติ ระบบบันทึกไว้เป็นประวัติ
  // และให้ปรับปรุงให้ถูกต้อง". One flag per (user, work_date, kind) — the
  // UNIQUE lets detection INSERT OR IGNORE idempotently so a staff isn't
  // nagged twice for the same lapse.
  db.exec(`
    CREATE TABLE IF NOT EXISTS attendance_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      branch_id INTEGER REFERENCES branches(id),
      work_date TEXT NOT NULL,
      kind TEXT NOT NULL
        CHECK (kind IN ('missing_in','missing_out','late','early','swap')),
      detail TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, work_date, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_attendance_flags_user
      ON attendance_flags(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_attendance_flags_branch
      ON attendance_flags(branch_id, work_date);
  `);

  // ── shift_swap_overrides — informal shift swaps confirmed at clock-in ──
  // (owner 2026-06-08). When น้องฮูก detects a staff clocking in far off
  // their rostered start and they answer "สลับกะกับเพื่อน", we store the
  // friend's shift window for that day here. The payroll engine + breakdown
  // overlay this onto the roster so pay is computed against the shift
  // actually worked — without mutating roster_assignments. One row per
  // (user, day); admin per-day overrides (payroll_line_days) still win.
  db.exec(`
    CREATE TABLE IF NOT EXISTS shift_swap_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      branch_id INTEGER REFERENCES branches(id),
      work_date TEXT NOT NULL,
      sched_in TEXT NOT NULL,
      sched_out TEXT NOT NULL,
      friend_user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, work_date)
    );
    CREATE INDEX IF NOT EXISTS idx_shift_swap_user
      ON shift_swap_overrides(user_id, work_date);
  `);

  // FT weekly payroll cancelled (owner 2026-06-09): full-time staff are paid
  // monthly only (not accounting-correct otherwise). Migrate any legacy
  // FT pay_cycle='weekly' → 'monthly' so they keep appearing in monthly
  // periods — the pay engine keys base pay on pay_cycle, so a stale 'weekly'
  // would otherwise zero their salary. Idempotent (no-op after first run).
  db.prepare(
    "UPDATE users SET pay_cycle = 'monthly' WHERE employment_type = 'ft' AND pay_cycle = 'weekly'"
  ).run();

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
  // 2026-05: shift_codes.kind enum — 'work' (default — current behaviour)
  // or 'day_off' (admin marks an explicit weekly off day in the roster
  // so the shift-reminder Flex fires "วันหยุดของพี่" instead of going
  // silent). On_leave is computed at notify time from leave_requests,
  // not a shift kind, so we don't need a third enum value here.
  const scCols = db.prepare("PRAGMA table_info(shift_codes)")
    .all() as Array<{ name: string }>;
  if (!scCols.some((c) => c.name === "kind")) {
    db.exec("ALTER TABLE shift_codes ADD COLUMN kind TEXT NOT NULL DEFAULT 'work'");
  }
  // Seed each branch with a 'day_off' shift code if it doesn't already
  // have one — admin can rename / recolour, but a default is helpful so
  // the roster UI works out of the box.
  db.exec(`
    INSERT INTO shift_codes
      (branch_id, code, name, start_time, end_time, color, display_order, kind)
    SELECT b.id, 'OFF', 'วันหยุด', '00:00', '00:00', '#94a3b8', 999, 'day_off'
    FROM branches b
    WHERE NOT EXISTS (
      SELECT 1 FROM shift_codes sc
      WHERE sc.branch_id = b.id AND sc.kind = 'day_off'
    )
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

  // System-wide default escalation window for the chain-of-command
  // approval flow (added 2026-05). Per-user override sits on
  // users.escalation_hours; super_admin sets the global fallback
  // here via /admin/system-settings.
  const ssCols = db.prepare("PRAGMA table_info(system_settings)")
    .all() as Array<{ name: string }>;
  if (!ssCols.some((c) => c.name === "default_escalation_hours")) {
    db.exec("ALTER TABLE system_settings ADD COLUMN default_escalation_hours INTEGER NOT NULL DEFAULT 24");
  }
  // improper_resignation_consequences (2026-05-27) — owner-authored
  // free-text shown to staff when they file a resignation, and to
  // admin when they tick "forfeit SVC" on approval. Single canonical
  // wording so the company speaks with one voice across both
  // surfaces. NULL on first migration; admin fills via
  // /admin/system-settings. The decide endpoint persists the SVC
  // forfeit flag itself — this column is the EXPLANATION text.
  if (!ssCols.some((c) => c.name === "improper_resignation_consequences")) {
    db.exec("ALTER TABLE system_settings ADD COLUMN improper_resignation_consequences TEXT");
  }
  // resignation_unlock_message (2026-05-27) — text body of the LINE
  // Flex card that fires when admin opens a staff's resignation gate.
  // Placeholders {ADMIN} = name of the admin who flipped the toggle.
  // Falls back to a sensible default when NULL.
  if (!ssCols.some((c) => c.name === "resignation_unlock_message")) {
    db.exec("ALTER TABLE system_settings ADD COLUMN resignation_unlock_message TEXT");
  }
  // Shift-reminder greeting overrides (2026-05-28). Each column stores
  // newline-separated greetings for one shift kind; the {NAME}
  // placeholder is replaced with the recipient's nickname (no space
  // after "พี่"). NULL = use the built-in defaults in
  // pickShiftGreeting(). Owner edits via /admin/persona/notifications.
  if (!ssCols.some((c) => c.name === "shift_greetings_work")) {
    db.exec("ALTER TABLE system_settings ADD COLUMN shift_greetings_work TEXT");
  }
  if (!ssCols.some((c) => c.name === "shift_greetings_day_off")) {
    db.exec("ALTER TABLE system_settings ADD COLUMN shift_greetings_day_off TEXT");
  }
  if (!ssCols.some((c) => c.name === "shift_greetings_on_leave")) {
    db.exec("ALTER TABLE system_settings ADD COLUMN shift_greetings_on_leave TEXT");
  }
  // Maintenance banner (2026-05-28). Two columns so the message is
  // a persistent TEMPLATE the owner authors ONCE — turning the
  // banner on/off is then a single toggle click before/after deploy,
  // not "retype the message every time".
  //   maintenance_message — template text. Stays in DB always.
  //   maintenance_active  — 0/1 toggle. Banner only renders when
  //     BOTH active=1 AND message is non-empty.
  if (!ssCols.some((c) => c.name === "maintenance_message")) {
    db.exec("ALTER TABLE system_settings ADD COLUMN maintenance_message TEXT");
  }
  if (!ssCols.some((c) => c.name === "maintenance_active")) {
    db.exec("ALTER TABLE system_settings ADD COLUMN maintenance_active INTEGER NOT NULL DEFAULT 0");
  }
  // ACCOUNTA bill-OCR (2026-06-16). OFF by default — the owner flips it on
  // in /admin/system-settings only when ANTHROPIC_API_KEY is configured,
  // so a missing key never breaks a deploy. model = which Claude vision
  // model to use (Haiku 4.5 by default — cheapest accurate-enough for
  // printed Thai bills; owner can switch to Sonnet for hard scans).
  if (!ssCols.some((c) => c.name === "accounta_ocr_enabled")) {
    db.exec("ALTER TABLE system_settings ADD COLUMN accounta_ocr_enabled INTEGER NOT NULL DEFAULT 0");
  }
  if (!ssCols.some((c) => c.name === "accounta_ocr_model")) {
    db.exec("ALTER TABLE system_settings ADD COLUMN accounta_ocr_model TEXT");
  }
  // Cron heartbeat (2026-05-25) — stamped by every successful POST
  // /api/cron call. Lets admin diagnose "is the external cron job
  // actually pinging us?" without SSH'ing into the VPS. NULL = never
  // called since the migration ran.
  if (!ssCols.some((c) => c.name === "last_cron_run_at")) {
    db.exec("ALTER TABLE system_settings ADD COLUMN last_cron_run_at TEXT");
  }
  // RECRUITA form template (2026-06-01) — JSON describing the
  // standard application form. Lets admin toggle/rename/reorder the
  // built-in fields without code changes. NULL = use the hardcoded
  // default from lib/recruita-form-template.ts. See that file for
  // the schema and the default value.
  if (!ssCols.some((c) => c.name === "recruita_form_template_json")) {
    db.exec("ALTER TABLE system_settings ADD COLUMN recruita_form_template_json TEXT");
  }
  // Privacy policy URL (2026-06-01) — single global URL the admin
  // pastes once (typically a Canva published-link or PDF on the
  // company site). Every PDPA consent banner (recruita apply, booking
  // form, walk-in, etc.) reads from here and renders a "ดูนโยบาย"
  // button when set. NULL/empty = no button rendered (legacy
  // behaviour). Plaintext URL — not a secret.
  if (!ssCols.some((c) => c.name === "privacy_policy_url")) {
    db.exec("ALTER TABLE system_settings ADD COLUMN privacy_policy_url TEXT");
  }
  // RECRUITA inline PDPA notice (2026-06-01) — the consent text shown
  // INSIDE the apply form (not a link out). Admin authors it in
  // /admin/system-settings. NULL/empty = render the built-in
  // DEFAULT_RECRUITA_PDPA_TEXT from lib/recruita.ts. Plaintext, with
  // newlines preserved on render.
  if (!ssCols.some((c) => c.name === "recruita_pdpa_text")) {
    db.exec("ALTER TABLE system_settings ADD COLUMN recruita_pdpa_text TEXT");
  }
  // RECRUITA interview venue map/navigation link (2026-06-11) — the
  // "นำทางมาสถานที่นัดสัมภาษณ์" button on the interview-invite LINE card
  // opens this. Owner pastes a Google Maps / share URL once in
  // /admin/system-settings. NULL/empty = the button is omitted.
  if (!ssCols.some((c) => c.name === "recruita_interview_map_url")) {
    db.exec("ALTER TABLE system_settings ADD COLUMN recruita_interview_map_url TEXT");
  }
  // RECRUITA health-check instructions (2026-06-14) — admin-editable body
  // shown on the "ตรวจสุขภาพ" LINE card sent to applicants who passed the
  // interview. NULL/empty = the card uses the built-in default text.
  if (!ssCols.some((c) => c.name === "recruita_health_check_message")) {
    db.exec("ALTER TABLE system_settings ADD COLUMN recruita_health_check_message TEXT");
  }
  // IKIGAI OS PORTAL OA "add friend" deep link (2026-06-15) — shown as a
  // button on the welcome card sent to a freshly-hired employee so they add
  // the staff OA and start receiving PERSONA notifications. NULL = button
  // omitted.
  if (!ssCols.some((c) => c.name === "portal_oa_link")) {
    db.exec("ALTER TABLE system_settings ADD COLUMN portal_oa_link TEXT");
  }
  // RECRUITA PDPA policy image (2026-06-02) — admin uploads an image
  // (PNG/JPG/WebP) of the privacy notice instead of typing dense text.
  // The apply form renders a "เปิดดูนโยบาย" button linking to the
  // public serve route. We store the absolute file path (under
  // data/recruita/_pdpa/, outside www-root) + its mime. NULL = no
  // image → apply form falls back to DEFAULT_RECRUITA_PDPA_TEXT.
  if (!ssCols.some((c) => c.name === "recruita_pdpa_image_path")) {
    db.exec("ALTER TABLE system_settings ADD COLUMN recruita_pdpa_image_path TEXT");
  }
  if (!ssCols.some((c) => c.name === "recruita_pdpa_image_mime")) {
    db.exec("ALTER TABLE system_settings ADD COLUMN recruita_pdpa_image_mime TEXT");
  }
  // Executive group LINE id (2026-06-01) — RECRUITA-specific. When
  // set, new application submissions push a Flex card into this
  // chat so owners see incoming candidates without polling the
  // admin UI. Distinct from global_staff_group_id, which is for
  // PERSONA/ASCENDA cross-branch staff notifications.
  if (!ssCols.some((c) => c.name === "recruita_exec_group_id")) {
    db.exec("ALTER TABLE system_settings ADD COLUMN recruita_exec_group_id TEXT");
  }
  // HR group name label (owner 2026-06-06) — shown next to every
  // notification setting so admin can see "this goes to XXXX group"
  // without having to remember which group ID maps to which chat.
  if (!ssCols.some((c) => c.name === "recruita_exec_group_name")) {
    db.exec("ALTER TABLE system_settings ADD COLUMN recruita_exec_group_name TEXT");
  }
  // SSO contribution settings (2026-05-26). Thailand defaults are
  // (SSO rate + cap live in payroll_settings table — adjust those via
  //  /admin/persona/payroll/settings, not here. We tried adding a
  //  duplicate copy on system_settings but it just causes drift between
  //  the two sources of truth. Single source = payroll_settings.)

  // ── Branch-level approval tiers (2026-05-26) ──────────────────────
  //
  // Replaces the per-user reports_to_user_id chain with a 2-tier
  // structure configured per branch:
  //   tier 1 = supervisors (any 1 approves → bumps to tier 2)
  //   tier 2 = executives  (any 1 approves → request approved)
  // Owner direction was: chain should be branch-level, not per-user.
  // The old reports_to_user_id column is kept in users for backward
  // compatibility but no UI writes to it anymore.
  db.exec(`
    CREATE TABLE IF NOT EXISTS branch_approval_tiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      tier_level INTEGER NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (branch_id, tier_level, user_id)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_bat_branch_tier
      ON branch_approval_tiers (branch_id, tier_level);
  `);

  // current_tier tracks where a pending leave/resignation request is
  // in the approval pipeline. NULL on rows submitted before the
  // migration — those still use the legacy current_approver_user_id
  // path. New rows submitted after the migration must have current_tier
  // set (the submission API enforces it).
  const lrColsT = db.prepare("PRAGMA table_info(leave_requests)").all() as Array<{ name: string }>;
  if (!lrColsT.some((c) => c.name === "current_tier")) {
    db.exec("ALTER TABLE leave_requests ADD COLUMN current_tier INTEGER");
  }
  const rrColsT = db.prepare("PRAGMA table_info(resignation_requests)").all() as Array<{ name: string }>;
  if (!rrColsT.some((c) => c.name === "current_tier")) {
    db.exec("ALTER TABLE resignation_requests ADD COLUMN current_tier INTEGER");
  }
  // branch_id on resignation_requests (added 2026-05-27 hotfix). The
  // tier-escalation cron sweep joins by branch_id; without this
  // column on resignation_requests the sweep threw SqliteError every
  // tick. Backfill from each requester's primary user_branches row
  // for any existing rows so the cron query stops short-circuiting.
  if (!rrColsT.some((c) => c.name === "branch_id")) {
    db.exec("ALTER TABLE resignation_requests ADD COLUMN branch_id INTEGER REFERENCES branches(id)");
    db.exec(`
      UPDATE resignation_requests
      SET branch_id = (
        SELECT ub.branch_id FROM user_branches ub
        WHERE ub.user_id = resignation_requests.user_id
        ORDER BY ub.branch_id ASC
        LIMIT 1
      )
      WHERE branch_id IS NULL
    `);
  }

  // Phase 1C v9: replaces_id for resignation_requests
  const rrcols = db.prepare("PRAGMA table_info(resignation_requests)").all() as Array<{ name: string }>;
  if (!rrcols.some((c) => c.name === "replaces_id")) {
    db.exec("ALTER TABLE resignation_requests ADD COLUMN replaces_id INTEGER");
  }

  // Chain-of-command tracking for resignation requests — same shape
  // as leave_requests so the assign-on-create + cron escalation
  // helpers work for both via a small switch on table name.
  if (!rrcols.some((c) => c.name === "current_approver_user_id")) {
    db.exec("ALTER TABLE resignation_requests ADD COLUMN current_approver_user_id INTEGER REFERENCES users(id)");
  }
  if (!rrcols.some((c) => c.name === "escalated_to_level")) {
    db.exec("ALTER TABLE resignation_requests ADD COLUMN escalated_to_level INTEGER NOT NULL DEFAULT 0");
  }
  if (!rrcols.some((c) => c.name === "last_escalated_at")) {
    db.exec("ALTER TABLE resignation_requests ADD COLUMN last_escalated_at TEXT");
  }
  if (!rrcols.some((c) => c.name === "approval_history")) {
    db.exec("ALTER TABLE resignation_requests ADD COLUMN approval_history TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_resignation_approver_pending ON resignation_requests(current_approver_user_id, status)");

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
  // is_test_account (2026-05-27) — flag to hide the row from every
  // operational list (employees table, payroll run, roster picker,
  // approval-chain config, daily attendance summary, etc.). Owner
  // direction: test accounts must NEVER mix with real staff in any
  // production view. They stay visible on test-notification +
  // super-admin config screens for system testing.
  //
  // Backfill heuristic: any account whose username is exactly "admin",
  // starts with "test", or whose display_name contains the Thai word
  // "ทดสอบ" is auto-flagged on first migration run. Admin can flip
  // the bit later via the employee edit modal checkbox.
  if (!unames3.has("is_test_account")) {
    db.exec("ALTER TABLE users ADD COLUMN is_test_account INTEGER NOT NULL DEFAULT 0");
    db.exec(`
      UPDATE users
      SET is_test_account = 1
      WHERE LOWER(username) = 'admin'
         OR LOWER(username) LIKE 'test%'
         OR display_name LIKE '%ทดสอบ%'
    `);
  }
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
  // 2026-05-30 — PDPA: gate payroll/salary visibility per-admin.
  //   0 = admin cannot see payroll pages or salary columns
  //   1 = super_admin has granted this admin payroll access
  // Default 0 closes the visibility leak immediately on deploy
  // (admins used to see every employee's monthly_salary in the
  // employee list). super_admin always sees payroll regardless of
  // this flag — gate enforced in `userCanViewPayroll()`.
  if (!unames3.has("can_view_payroll")) {
    db.exec("ALTER TABLE users ADD COLUMN can_view_payroll INTEGER NOT NULL DEFAULT 0");
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
  // 2026-06-01 — RECRUITA needs a second LIFF id because the apply
  // page (LIFF #1) and the status page (LIFF #2) live at different
  // endpoint URLs but should both authenticate the same candidate.
  // Both LIFF apps live under the same LINE Login channel → same
  // userId — but each LIFF id is tied to its endpoint by LINE. Older
  // channels (platform/reserva) only need one, so this column is
  // nullable and unused there.
  if (!mcCols.some((c) => c.name === "liff_id_status")) {
    db.exec("ALTER TABLE messaging_channels ADD COLUMN liff_id_status TEXT");
  }

  // ── 2026-06-01 RECRUITA OA support ─────────────────────────────
  // RECRUITA uses a separate LINE OA ("IKIGAI Recruit") for the
  // candidate-facing flow so the message blasts to applicants don't
  // bleed into the main IKIGAI OS staff channel. Schema needs:
  //   1. CHECK constraint widened to accept scope='recruita'
  //   2. Seed row code='ikigai-recruit' so the admin UI always has
  //      a target to fill in.
  //
  // The original CHECK only allowed 'platform' | 'reserva'. SQLite
  // doesn't support ALTER on CHECK, so we rebuild the table when the
  // constraint is missing. Detected by trying a no-op test insert
  // inside a savepoint — cheaper than parsing sqlite_master and
  // safer than regex on stored DDL.
  let scopeCheckOk = false;
  try {
    db.exec("SAVEPOINT scope_check");
    db.prepare(
      "INSERT INTO messaging_channels (scope, code, label) VALUES ('recruita', '__probe__', '__probe__')"
    ).run();
    db.exec("ROLLBACK TO SAVEPOINT scope_check");
    db.exec("RELEASE SAVEPOINT scope_check");
    scopeCheckOk = true;
  } catch {
    try { db.exec("ROLLBACK TO SAVEPOINT scope_check"); db.exec("RELEASE SAVEPOINT scope_check"); }
    catch { /* probe already rolled back */ }
  }
  if (!scopeCheckOk) {
    // Rebuild — copy rows into a new table that allows 'recruita',
    // drop the old one, rename. PRAGMA foreign_keys is on per
    // top-of-file, so we briefly turn it off to keep the swap simple.
    db.exec("PRAGMA foreign_keys = OFF");
    // Re-read the column list — by now liff_id and liff_id_status may
    // have been added by the ALTERs above. Using the stale `mcCols`
    // snapshot here would falsely report liff_id_status as missing
    // and silently drop it during rebuild.
    const liveCols = db.prepare("PRAGMA table_info(messaging_channels)").all() as Array<{ name: string }>;
    const hasStatusCol = liveCols.some((c) => c.name === "liff_id_status");
    const statusCreate = hasStatusCol ? "liff_id_status TEXT," : "";
    const statusInsertCols = hasStatusCol ? ", liff_id_status" : "";
    const statusSelectCols = hasStatusCol ? ", liff_id_status" : "";
    db.exec(`
      CREATE TABLE messaging_channels_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL CHECK (scope IN ('platform','reserva','recruita')),
        code TEXT UNIQUE NOT NULL,
        label TEXT NOT NULL,
        branch_id INTEGER REFERENCES branches(id),
        channel_secret TEXT,
        channel_token TEXT,
        liff_id TEXT,
        ${statusCreate}
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_by INTEGER REFERENCES users(id)
      );
      INSERT INTO messaging_channels_new
        (id, scope, code, label, branch_id, channel_secret, channel_token,
         liff_id, updated_at, updated_by${statusInsertCols})
      SELECT id, scope, code, label, branch_id, channel_secret, channel_token,
             liff_id, updated_at, updated_by${statusSelectCols}
      FROM messaging_channels;
      DROP TABLE messaging_channels;
      ALTER TABLE messaging_channels_new RENAME TO messaging_channels;
    `);
    db.exec("PRAGMA foreign_keys = ON");
  }

  db.exec(`
    INSERT OR IGNORE INTO messaging_channels (scope, code, label)
      VALUES ('recruita', 'ikigai-recruit', 'IKIGAI Recruit');
  `);

  // 2026-06-14 — configurable "add OA as friend" deep link for the RECRUITA
  // apply gate (RC-4). Shown to applicants who open the form OUTSIDE LINE so
  // they can add the IKIGAI Recruit OA and re-enter via the Rich Menu (LIFF),
  // where their LINE userId is captured. Editable in the RECRUITA OA settings;
  // NULL/empty falls back to DEFAULT_RECRUITA_OA_LINK. Placed AFTER the scope
  // rebuild above so it survives on freshly-rebuilt tables too.
  const mcCols2 = db.prepare("PRAGMA table_info(messaging_channels)").all() as Array<{ name: string }>;
  if (!mcCols2.some((c) => c.name === "oa_link")) {
    db.exec("ALTER TABLE messaging_channels ADD COLUMN oa_link TEXT");
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

  // Unpaid-leave days on a payroll line (owner 2026-06-17). Opt-in: default
  // 0 means no change to any existing line. When > 0 the compute deducts
  // salary/30 per day from FT base pay (see payroll-compute.ts).
  const plColsUnpaid = db.prepare("PRAGMA table_info(payroll_lines)").all() as Array<{ name: string }>;
  if (!plColsUnpaid.some((c) => c.name === "unpaid_leave_days")) {
    db.exec("ALTER TABLE payroll_lines ADD COLUMN unpaid_leave_days REAL NOT NULL DEFAULT 0");
  }

  // payroll_line_audit — accountability trail for manual edits to a
  // payroll line (owner 2026-06-02: "แอดมินแก้ได้ แต่ต้องกด PIN แล้ว
  // บันทึก log การแก้ไขไว้ด้วย"). Every PIN-verified edit appends one
  // row with the full before/after JSON of the line's editable fields,
  // who did it, and an optional note. Money data → never silently
  // mutated.
  db.exec(`
    CREATE TABLE IF NOT EXISTS payroll_line_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_id INTEGER NOT NULL,
      target_user_id INTEGER NOT NULL,
      admin_id INTEGER NOT NULL REFERENCES users(id),
      mode TEXT NOT NULL,              -- 'hours' | 'amount'
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_line_audit_period
      ON payroll_line_audit(period_id, target_user_id);
  `);

  // payroll_line_days — per-day clock-in/out OVERRIDES, payroll-scoped
  // (owner 2026-06-03). When an admin edits a day's recorded time in the
  // payroll modal we store it here, NOT on time_entries — the staff's
  // real attendance log is never mutated. Recompute merges these over
  // the auto time-clock data: a (period,user,date) row replaces whatever
  // the time-clock said for that day. NULL clock_in/clock_out = that day
  // has no paid shift (e.g. marked absent). Times are 'HH:MM' BKK local.
  db.exec(`
    CREATE TABLE IF NOT EXISTS payroll_line_days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      work_date TEXT NOT NULL,          -- YYYY-MM-DD (BKK)
      clock_in TEXT,                    -- 'HH:MM' or NULL
      clock_out TEXT,                   -- 'HH:MM' or NULL
      edited_by INTEGER REFERENCES users(id),
      edited_at TEXT,
      UNIQUE (period_id, user_id, work_date)
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_line_days_pu
      ON payroll_line_days(period_id, user_id);
  `);

  // 2026-06-03: per-day FIELD overrides on payroll_line_days. The admin
  // edits any wrong value in the daily breakdown directly (PIN + log) and
  // the typed value wins over the computed one. All nullable — null = use
  // the computed value, so existing payroll is unaffected unless an admin
  // explicitly overrides a field.
  const pldCols = db.prepare("PRAGMA table_info(payroll_line_days)")
    .all() as Array<{ name: string }>;
  const addPld = (col: string, decl: string) => {
    if (!pldCols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE payroll_line_days ADD COLUMN ${col} ${decl}`);
    }
  };
  addPld("sched_in", "TEXT");      // 'HH:MM' override of the gate start
  addPld("sched_out", "TEXT");     // 'HH:MM' override of the gate end
  addPld("break_min", "INTEGER");  // override break minutes
  addPld("worked_min", "INTEGER"); // override regular working minutes
  addPld("ot_min", "INTEGER");     // (legacy) override OT minutes — superseded by ot_until
  addPld("ot_pay", "REAL");        // override OT pay (THB)
  // 2026-06-03b: OT is no longer typed as hours — the admin enters the
  // approved "until" time (HH:MM) and the engine extends the worked
  // window to it, then the 8h split decides regular vs OT rate. Falls
  // back to the approved ot_requests row when this is null.
  addPld("ot_until", "TEXT");      // 'HH:MM' approved OT until-time override

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

  // 2026-06-10 Per-branch payroll periods. payroll_periods was global, so
  // computePayrollPeriod pulled EVERY employee across all branches into a
  // single period (owner: NAMA's FT payroll listed AT HOME staff). Add
  // branch_id + widen UNIQUE to include it so each branch keeps its own
  // period for the same dates. foreign_keys is OFF during the swap
  // (payroll_lines references this table) so the DROP can't cascade-delete
  // the lines; legacy rows carry branch_id = NULL (treated as "all
  // branches" by the compute fallback).
  const ppBranchSql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='payroll_periods'"
  ).get() as { sql: string } | undefined;
  if (ppBranchSql && !ppBranchSql.sql.includes("branch_id")) {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(`
      CREATE TABLE payroll_periods_b (
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
        branch_id INTEGER REFERENCES branches(id),
        UNIQUE (cycle, period_start, period_end, branch_id)
      );
      INSERT INTO payroll_periods_b
        (id, cycle, period_start, period_end, pay_date, status,
         ot_mode_snapshot, ot_flat_per_15min_snapshot,
         computed_by, computed_at, finalized_by, finalized_at,
         notes, created_by, created_at, target, paid_at, paid_by, data_source, branch_id)
      SELECT id, cycle, period_start, period_end, pay_date, status,
             ot_mode_snapshot, ot_flat_per_15min_snapshot,
             computed_by, computed_at, finalized_by, finalized_at,
             notes, created_by, created_at, target, paid_at, paid_by, data_source, NULL
      FROM payroll_periods;
      DROP TABLE payroll_periods;
      ALTER TABLE payroll_periods_b RENAME TO payroll_periods;
      CREATE INDEX IF NOT EXISTS idx_payroll_periods_dates
        ON payroll_periods(period_start, period_end);
      CREATE INDEX IF NOT EXISTS idx_payroll_periods_status
        ON payroll_periods(status, period_end);
      CREATE INDEX IF NOT EXISTS idx_payroll_periods_branch
        ON payroll_periods(branch_id, period_end);
    `);
    db.exec("PRAGMA foreign_keys = ON");
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

  // Per-branch registered address + tax branch code. Each branch
  // files its own ที่อยู่จดทะเบียน for government paperwork
  // (ใบกำกับภาษี / หนังสือราชการ). tax_branch_code: '00000' =
  // สำนักงานใหญ่, '00001'+ = สาขาที่ N. When a company has zero
  // branches the company's own address is treated as the head
  // office at document time. Idempotent per-column ALTER.
  const branchRegCols = new Set(
    (db.prepare("PRAGMA table_info(branches)").all() as Array<{ name: string }>)
      .map((c) => c.name)
  );
  if (!branchRegCols.has("reg_address")) {
    db.exec("ALTER TABLE branches ADD COLUMN reg_address TEXT");
  }
  if (!branchRegCols.has("tax_branch_code")) {
    db.exec("ALTER TABLE branches ADD COLUMN tax_branch_code TEXT");
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

  // 2026-06-03: repair admins onboarded via invite BEFORE the invite flow
  // set is_admin. Their user_branches row defaulted to is_admin=0, so a
  // role='admin' account ended up with zero admin-branches — requireAdmin
  // treated them as staff and the sidebar's "มุมมองผู้ดูแลระบบ" switch never
  // showed. Repair: any active role='admin' user with NO is_admin=1 branch
  // gets is_admin=1 on every branch they belong to. Idempotent (the
  // NOT EXISTS clause stops matching once repaired) and scoped to the
  // broken state, so admins with an intentional per-branch split are left
  // alone. super_admin is global and isn't role='admin' here.
  db.exec(`
    UPDATE user_branches SET is_admin = 1
    WHERE user_id IN (
      SELECT u.id FROM users u
      WHERE u.role = 'admin' AND u.status != 'disabled'
        AND NOT EXISTS (
          SELECT 1 FROM user_branches ub2
          WHERE ub2.user_id = u.id AND ub2.is_admin = 1
        )
    )
  `);

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

  // Validity window — added 2026-05-22. Lets the admin specify how
  // many months a warning stays "active" for the purposes of
  // escalation. After this many months past issued_at, the warning
  // is treated as expired and no longer counts toward "previous
  // offence within active window" calculations. NULL = no expiry
  // (warning is active indefinitely, legacy behavior).
  const dwCols = db.prepare("PRAGMA table_info(disciplinary_warnings)").all() as Array<{ name: string }>;
  const dwNames = new Set(dwCols.map((c) => c.name));
  if (!dwNames.has("validity_months")) {
    db.exec("ALTER TABLE disciplinary_warnings ADD COLUMN validity_months INTEGER");
  }

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
    ).replace(
      // Match `CREATE TABLE [IF NOT EXISTS] (users|"users"|`users`)`
      // explicitly. The previous `["`]?users["`]?\b` pattern failed when
      // SQLite stored the DDL with quoted name — `\b` couldn't match
      // between two non-word chars (`"` and ` `), so regex backtracked
      // to leave the closing quote unconsumed, producing
      // `CREATE TABLE users_new" (...)` which throws "unrecognized token".
      /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"users"|`users`|users)/i,
      "CREATE TABLE users_new"
    );
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

  // 2026-05-28: extend users.status CHECK with 'resigned' so the
  // nightly resignation sweep can flip users when their approved
  // resignation's proposed_last_day has passed. Same rebuild pattern
  // used for users.role above — SQLite CHECK constraints are immutable
  // so the only way to widen is to clone the table.
  const userTableDdlForStatus = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'"
  ).get() as { sql: string } | undefined;
  if (userTableDdlForStatus
      && /CHECK\s*\(\s*status\s+IN\s*\([^)]*\)/i.test(userTableDdlForStatus.sql)
      && !/'resigned'/.test(userTableDdlForStatus.sql)) {
    const userCols2 = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    const colList = userCols2.map((c) => `"${c.name}"`).join(", ");
    const newDdl = userTableDdlForStatus.sql
      .replace(
        /CHECK\s*\(\s*status\s+IN\s*\([^)]+\)\s*\)/i,
        "CHECK (status IN ('active','pending_invite','disabled','resigned'))"
      )
      .replace(
      // Match `CREATE TABLE [IF NOT EXISTS] (users|"users"|`users`)`
      // explicitly. The previous `["`]?users["`]?\b` pattern failed when
      // SQLite stored the DDL with quoted name — `\b` couldn't match
      // between two non-word chars (`"` and ` `), so regex backtracked
      // to leave the closing quote unconsumed, producing
      // `CREATE TABLE users_new" (...)` which throws "unrecognized token".
      /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"users"|`users`|users)/i,
      "CREATE TABLE users_new"
    );
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

  // 2026-05-30: widen time_entries_audit.action CHECK to include
  // 'cert-approve' and 'cert-reject'. The time-certification approve
  // route INSERTs into this audit table with action='cert-approve'
  // — under the legacy CHECK constraint that throws
  // SQLITE_CONSTRAINT_CHECK, the whole transaction rolls back, and
  // the admin sees "approve button doesn't work" because nothing
  // succeeded. Same CHECK-widening pattern as users.role/status above.
  //
  // The CREATE TABLE statement at the top of this function now has
  // the widened CHECK so fresh installs are correct; this block
  // upgrades existing prod tables in place.
  const auditTableDdl = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='time_entries_audit'"
  ).get() as { sql: string } | undefined;
  if (auditTableDdl
      && /CHECK\s*\(\s*action\s+IN\s*\([^)]*\)/i.test(auditTableDdl.sql)
      && !/'cert-approve'/.test(auditTableDdl.sql)) {
    const auditCols = db.prepare("PRAGMA table_info(time_entries_audit)").all() as Array<{ name: string }>;
    const colList = auditCols.map((c) => `"${c.name}"`).join(", ");
    const newDdl = auditTableDdl.sql
      .replace(
        /CHECK\s*\(\s*action\s+IN\s*\([^)]+\)\s*\)/i,
        "CHECK (action IN ('delete','edit','create','cert-approve','cert-reject'))"
      )
      .replace(
        // Same explicit-alternation pattern that fixed the 2026-05-28
        // users-table rebuild bug. `\b` against `"` is unreliable, so
        // enumerate quoted / backticked / bare names explicitly.
        /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"time_entries_audit"|`time_entries_audit`|time_entries_audit)/i,
        "CREATE TABLE time_entries_audit_new"
      );
    db.exec("BEGIN");
    try {
      db.exec(newDdl);
      db.exec(`INSERT INTO time_entries_audit_new (${colList}) SELECT ${colList} FROM time_entries_audit`);
      db.exec("DROP TABLE time_entries_audit");
      db.exec("ALTER TABLE time_entries_audit_new RENAME TO time_entries_audit");
      // Re-create the index — DROP TABLE drops it implicitly.
      db.exec("CREATE INDEX IF NOT EXISTS idx_time_audit_created ON time_entries_audit(created_at)");
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  // resigned_at — ISO timestamp the cron stamped when it flipped the
  // user's status to 'resigned'. Used by the 1-year purge sweep to
  // pick rows up for deletion. NULL for users who haven't gone
  // through the resignation flow.
  // Defensive try/catch around ALTER — if the column was added by a
  // manual SQL fix on prod (and the PRAGMA cache is stale for any
  // reason), the "duplicate column name" error is benign and we
  // swallow it so boot doesn't loop-crash. Any other error rethrows.
  const userColsForResign = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!userColsForResign.some((c) => c.name === "resigned_at")) {
    try {
      db.exec("ALTER TABLE users ADD COLUMN resigned_at TEXT");
    } catch (e) {
      if (!String(e).includes("duplicate column")) throw e;
    }
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

  // 2026-06-04: occupational-health exam type (owner). Classifies each
  // employee health record into one of the post-hire exam categories:
  //   'periodic'        — ตรวจประจำปี (the existing ส.ณ.11 food-handler cert
  //                       is a periodic exam → existing rows default here)
  //   'pre_placement'   — ก่อนเริ่มงาน ตามปัจจัยเสี่ยงของตำแหน่ง
  //   'return_to_work'  — ประเมินกลับเข้าทำงานหลังพัก
  // (Pre-employment lives in RECRUITA, before the person is an employee.)
  const hcCols = db.prepare("PRAGMA table_info(health_checkups)")
    .all() as Array<{ name: string }>;
  if (!hcCols.some((c) => c.name === "exam_type")) {
    db.exec("ALTER TABLE health_checkups ADD COLUMN exam_type TEXT NOT NULL DEFAULT 'periodic'");
  }

  // ══════════════════════════════════════════════════════════════════
  // Mounjaro Employee Wellness — phase 2 (clinical data, owner 2026-06-04)
  //
  // SQLite has no row-level security, so isolation is enforced in the
  // application gateway (src/lib/mounjaro-db.ts) + audited + tested.
  // Access model (locked in docs/mounjaro-integration-plan.md §14):
  //   • employee   → only their own rows (via enrollment_id)
  //   • doctor     → only patients where attending_doctor_id = self,
  //                  unlocked by their license_no
  //   • nurse      → NO clinical view (this phase)
  //   • super_admin/HR → aggregate stats only, never raw clinical rows
  // JSON columns are TEXT (no jsonb). Soft-delete via deleted_at so the
  // medical record survives a PDPA erasure (kept under lawful basis).
  // ══════════════════════════════════════════════════════════════════

  // Clinical access flags on users (super_admin grants; pattern mirrors
  // can_view_payroll). userCol() is idempotent (PRAGMA-guarded).
  userCol("clinical_role", "TEXT");                 // 'doctor' | 'nurse' | NULL
  userCol("license_no", "TEXT");                    // professional license (unlock gate)
  userCol("is_hr_analytics", "INTEGER NOT NULL DEFAULT 0");

  db.exec(`
    CREATE TABLE IF NOT EXISTS mounjaro_enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','active','withdrawn','completed')),
      enrolled_at TEXT, completed_at TEXT,
      consent_signed_at TEXT, consent_version TEXT,
      withdrawn_reason TEXT,
      portal_erased_at TEXT,                  -- PDPA soft-delete (portal side)
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(employee_id)
    );

    CREATE TABLE IF NOT EXISTS mounjaro_patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enrollment_id INTEGER NOT NULL UNIQUE
        REFERENCES mounjaro_enrollments(id) ON DELETE CASCADE,
      attending_doctor_id INTEGER REFERENCES users(id),  -- เจ้าของไข้
      hn TEXT,                                  -- จากระบบแอทโฮมคลินิก (กรอกมือ)
      baseline_json TEXT,
      comorbidities_json TEXT,
      contraindications_json TEXT,
      medications_json TEXT,
      notes TEXT, start_date TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS mounjaro_visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL REFERENCES mounjaro_patients(id) ON DELETE CASCADE,
      date TEXT,
      dose REAL CHECK (dose IN (2.5,5,7.5,10,12.5,15)),
      weight REAL, bp TEXT, hr INTEGER, hba1c REAL, fbs REAL, waist REAL,
      side_effects_json TEXT,
      hypo_count INTEGER,
      adherence TEXT CHECK (adherence IN ('full','missed1','missed2','held')),
      decision TEXT CHECK (decision IN ('maintain','increase','decrease','hold')),
      next_visit TEXT, notes TEXT,
      entered_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS mounjaro_self_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enrollment_id INTEGER NOT NULL
        REFERENCES mounjaro_enrollments(id) ON DELETE CASCADE,
      date TEXT, weight REAL, injection_done INTEGER,
      side_effect_diary_json TEXT, notes_for_doctor TEXT,
      doctor_reply TEXT, replied_by INTEGER REFERENCES users(id), replied_at TEXT,
      logged_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS mounjaro_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id INTEGER,
      ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS mounjaro_consent_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Exercise log (owner #11-16, 2026-06-06). One row per activity the
    -- participant self-records (multiple per day allowed). met/level are
    -- snapshotted from exerciseCatalog at log time so historical rows are
    -- stable even if the catalog changes. kcal_est is NULL when we have no
    -- baseline weight (shown as "—", never invented).
    CREATE TABLE IF NOT EXISTS mounjaro_exercise_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enrollment_id INTEGER NOT NULL
        REFERENCES mounjaro_enrollments(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      activity_id TEXT NOT NULL,
      level TEXT NOT NULL,
      duration_min INTEGER NOT NULL,
      met REAL NOT NULL,
      rpe INTEGER NOT NULL,
      kcal_est REAL,
      source TEXT NOT NULL DEFAULT 'self-select',
      logged_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_mj_enroll_employee ON mounjaro_enrollments(employee_id);
    CREATE INDEX IF NOT EXISTS idx_mj_patient_doctor  ON mounjaro_patients(attending_doctor_id);
    CREATE INDEX IF NOT EXISTS idx_mj_visit_patient   ON mounjaro_visits(patient_id);
    CREATE INDEX IF NOT EXISTS idx_mj_selflog_enroll  ON mounjaro_self_logs(enrollment_id);
    CREATE INDEX IF NOT EXISTS idx_mj_exlog_enroll    ON mounjaro_exercise_logs(enrollment_id, date DESC);
    CREATE INDEX IF NOT EXISTS idx_mj_audit_user      ON mounjaro_audit_log(user_id, created_at DESC);

    -- HR / management aggregate view — NO row identifies a person.
    DROP VIEW IF EXISTS mounjaro_program_stats;
    CREATE VIEW mounjaro_program_stats AS
      SELECT
        (SELECT COUNT(*) FROM mounjaro_enrollments) AS total_enrolled,
        (SELECT COUNT(*) FROM mounjaro_enrollments WHERE status='active') AS active_count,
        (SELECT COUNT(*) FROM mounjaro_enrollments WHERE status='pending') AS pending_count,
        (SELECT COUNT(*) FROM mounjaro_enrollments WHERE status='withdrawn') AS withdrawn_count,
        (SELECT COUNT(*) FROM mounjaro_enrollments WHERE status='completed') AS completed_count;
  `);

  // Seed a default active consent version if none exists (super_admin can
  // add new versions later; a version bump forces re-consent).
  const hasMjConsent = db.prepare("SELECT 1 FROM mounjaro_consent_versions LIMIT 1").get();
  if (!hasMjConsent) {
    db.prepare("INSERT INTO mounjaro_consent_versions (version, body, active) VALUES ('v1', ?, 1)").run(
      "ข้าพเจ้ายินยอมเข้าร่วมโครงการ Mounjaro Employee Wellness โดยสมัครใจ และยินยอมให้แพทย์/พยาบาล IKIGAI MediHealth (AT HOME CLINIC) เก็บรวบรวม ใช้ และประมวลผลข้อมูลสุขภาพของข้าพเจ้า (น้ำหนัก ผลตรวจ อาการข้างเคียง ฯลฯ) เพื่อการดูแลรักษาและติดตามผลภายใต้โครงการนี้เท่านั้น\n\n" +
      "• ข้อมูลสุขภาพถือเป็นข้อมูลส่วนบุคคลอ่อนไหวตาม พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล (PDPA)\n" +
      "• เฉพาะแพทย์เจ้าของไข้เท่านั้นที่เข้าถึงข้อมูลการรักษาของข้าพเจ้าได้ ทุกการเข้าถึงถูกบันทึก\n" +
      "• ฝ่ายบุคคล/ผู้บริหารเห็นเพียงสถิติภาพรวม ไม่เห็นข้อมูลรายบุคคล\n" +
      "• ข้าพเจ้าสามารถขอออกจากโครงการ ขอดู หรือขอลบข้อมูลในพอร์ทัลได้ทุกเมื่อ (เวชระเบียนคลินิกเก็บตามที่กฎหมายกำหนด)\n" +
      "• ข้าพเจ้าเข้าใจว่ายา Tirzepatide (Mounjaro) ต้องใช้ภายใต้การดูแลของแพทย์ และอาจมีผลข้างเคียง"
    );
  }

  // Daily self-log extras (2026-06-05): vitals + a food/exercise diary so
  // participants can log every day (not only at clinic visits) and the
  // data can feed the progress chart. PRAGMA-guarded ALTERs — the table
  // is created above via CREATE TABLE IF NOT EXISTS which never adds
  // columns to an already-existing table.
  {
    const slCols = new Set(
      (db.prepare("PRAGMA table_info(mounjaro_self_logs)").all() as Array<{ name: string }>)
        .map((c) => c.name)
    );
    if (!slCols.has("bp")) db.exec("ALTER TABLE mounjaro_self_logs ADD COLUMN bp TEXT");
    if (!slCols.has("hr")) db.exec("ALTER TABLE mounjaro_self_logs ADD COLUMN hr INTEGER");
    if (!slCols.has("fbs")) db.exec("ALTER TABLE mounjaro_self_logs ADD COLUMN fbs REAL");
    if (!slCols.has("diary")) db.exec("ALTER TABLE mounjaro_self_logs ADD COLUMN diary TEXT");
  }

  // Consent "last updated" timestamp (2026-06-05): the editor shows
  // "อัปเดตล่าสุดเมื่อวันที่ …" instead of a vN label. Versions are kept
  // internally (re-consent logic compares them) but not surfaced.
  {
    const cvCols = new Set(
      (db.prepare("PRAGMA table_info(mounjaro_consent_versions)").all() as Array<{ name: string }>)
        .map((c) => c.name)
    );
    if (!cvCols.has("updated_at")) db.exec("ALTER TABLE mounjaro_consent_versions ADD COLUMN updated_at TEXT");
  }

  // Doctor-invite flow (owner 2026-06-06): enrollment is now always
  // initiated by a doctor. The employee CANNOT self-enroll; they can
  // only confirm an invitation sent by the attending doctor.
  //   invited_by_doctor_id — who sent the invite
  //   invited_at           — when the invite was sent
  //   employee_confirmed_at — when the employee accepted
  // An enrollment without employee_confirmed_at is "waiting for employee
  // to confirm". Only confirmed enrollments show in the doctor's intake
  // list. This removes the need for a self-enroll banner on the staff
  // portal.
  {
    const enrCols2 = new Set(
      (db.prepare("PRAGMA table_info(mounjaro_enrollments)").all() as Array<{ name: string }>)
        .map((c) => c.name)
    );
    if (!enrCols2.has("invited_by_doctor_id"))
      db.exec("ALTER TABLE mounjaro_enrollments ADD COLUMN invited_by_doctor_id INTEGER REFERENCES users(id)");
    if (!enrCols2.has("invited_at"))
      db.exec("ALTER TABLE mounjaro_enrollments ADD COLUMN invited_at TEXT");
    if (!enrCols2.has("employee_confirmed_at"))
      db.exec("ALTER TABLE mounjaro_enrollments ADD COLUMN employee_confirmed_at TEXT");
  }

  // ══════════════════════════════════════════════════════════════════
  // Health module — facility config + exam PDF + leave-approval (2026-06-05)
  // ──────────────────────────────────────────────────────────────────
  // health_facilities — the company's contracted health-consulting clinic
  // (was hardcoded "AT HOME CLINIC" everywhere). Admin maintains name +
  // license + address; the self-portal, consent text and clinical UI pull
  // the default facility instead of a literal string. Multiple rows are
  // supported (is_default flags the one used by default).
  db.exec(`
    CREATE TABLE IF NOT EXISTS health_facilities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      license_no TEXT,
      address TEXT,
      logo_path TEXT,                          -- public path, e.g. /ahc-logo.png
      is_default INTEGER NOT NULL DEFAULT 0,   -- exactly one row = 1
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    );
  `);
  // Seed the company's facility once (owner 2026-06-05): แอทโฮมคลินิกเวชกรรม
  // สาขาบ่อวิน, ใบอนุญาตประกอบกิจการสถานพยาบาลเลขที่ 20101005164. Address left
  // blank for the admin to fill. Guarded by "no rows yet" so it never
  // overwrites later admin edits.
  const hasFacility = db.prepare("SELECT 1 FROM health_facilities LIMIT 1").get();
  if (!hasFacility) {
    db.prepare(`
      INSERT INTO health_facilities (name, license_no, address, logo_path, is_default)
      VALUES (?, ?, NULL, ?, 1)
    `).run("แอทโฮมคลินิกเวชกรรม สาขาบ่อวิน", "20101005164", "/ahc-logo.png");
  }

  // health_checkups: attach the actual exam PDF/image (owner 2026-06-05).
  // The legacy attachment_url (a Drive link) stays for back-compat; new
  // uploads land in file_path (+ file_mime) served via an auth-gated route.
  {
    const hc2 = new Set(
      (db.prepare("PRAGMA table_info(health_checkups)").all() as Array<{ name: string }>)
        .map((c) => c.name)
    );
    if (!hc2.has("file_path")) db.exec("ALTER TABLE health_checkups ADD COLUMN file_path TEXT");
    if (!hc2.has("file_mime")) db.exec("ALTER TABLE health_checkups ADD COLUMN file_mime TEXT");
  }

  // mounjaro_enrollments: doctor-approved withdraw/erase (owner 2026-06-05).
  // Leaving the program or erasing portal data is no longer immediate — the
  // employee files a request (pending_action), the attending doctor
  // approves, and only then is withdrawSelf/eraseMyData executed.
  {
    const enrCols = new Set(
      (db.prepare("PRAGMA table_info(mounjaro_enrollments)").all() as Array<{ name: string }>)
        .map((c) => c.name)
    );
    if (!enrCols.has("pending_action")) db.exec("ALTER TABLE mounjaro_enrollments ADD COLUMN pending_action TEXT"); // 'withdraw' | 'erase' | NULL
    if (!enrCols.has("pending_action_reason")) db.exec("ALTER TABLE mounjaro_enrollments ADD COLUMN pending_action_reason TEXT");
    if (!enrCols.has("pending_action_at")) db.exec("ALTER TABLE mounjaro_enrollments ADD COLUMN pending_action_at TEXT");
  }

  // ══════════════════════════════════════════════════════════════════
  // RBAC — บทบาท/สิทธิ์การเข้าถึงโมดูล (2026-06-04)
  // ──────────────────────────────────────────────────────────────────
  // Generic, owner-definable roles that grant access to admin MODULES
  // (PERSONA / RESERVA / RECRUITA / INSIGNA / ASCENDA). Layered ADDITIVELY
  // on top of the existing role/branch gates so nobody loses access:
  //   • super_admin   → bypasses everything (god) — never needs a role.
  //   • legacy admins → keep entering the console; backfilled with the
  //                     "ผู้ดูแลระบบ (ทุกโมดูล)" system role so the new
  //                     module gates don't bite them.
  //   • staff         → no roles = no admin access (unchanged). Assign a
  //                     role to grant specific module access.
  // Payroll (can_view_payroll), clinical (clinical_role + license_no) and
  // HR-aggregate (is_hr_analytics) keep their dedicated grants — those are
  // PDPA-sensitive and stay where they are. The role catalog lives in
  // src/lib/rbac.ts (shared with the UI). userCan() lives in auth.ts.
  // ══════════════════════════════════════════════════════════════════
  db.exec(`
    CREATE TABLE IF NOT EXISTS rbac_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE,                          -- stable key for system roles; NULL for custom
      name TEXT NOT NULL,
      description TEXT,
      is_system INTEGER NOT NULL DEFAULT 0,     -- 1 = seeded, cannot be deleted
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS rbac_role_permissions (
      role_id INTEGER NOT NULL REFERENCES rbac_roles(id) ON DELETE CASCADE,
      permission_key TEXT NOT NULL,
      PRIMARY KEY (role_id, permission_key)
    );
    CREATE TABLE IF NOT EXISTS rbac_user_roles (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id INTEGER NOT NULL REFERENCES rbac_roles(id) ON DELETE CASCADE,
      assigned_by INTEGER REFERENCES users(id),
      assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, role_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rbac_uroles_user ON rbac_user_roles(user_id);
    CREATE INDEX IF NOT EXISTS idx_rbac_rperms_role ON rbac_role_permissions(role_id);
  `);

  // First-run seed + backfill. Guarded by the existence of the system
  // role: it runs EXACTLY ONCE (when the role is first created), so any
  // later edits/removals the owner makes in the UI stick across reboots.
  const legacyAdminRole = db.prepare(
    "SELECT id FROM rbac_roles WHERE key = 'legacy_admin'"
  ).get() as { id: number } | undefined;
  if (!legacyAdminRole) {
    const info = db.prepare(
      "INSERT INTO rbac_roles (key, name, description, is_system) VALUES ('legacy_admin', ?, ?, 1)"
    ).run(
      "ผู้ดูแลระบบ (ทุกโมดูล)",
      "บทบาทระบบ — เข้าถึงทุกโมดูลผู้ดูแล (PERSONA / RESERVA / RECRUITA / INSIGNA / ASCENDA / ACCOUNTA) เทียบเท่าผู้ดูแลเดิม"
    );
    const roleId = Number(info.lastInsertRowid);
    // All module permissions (must match RBAC_PERMISSION_KEYS in lib/rbac.ts).
    for (const perm of [
      "persona.manage", "reserva.manage", "recruita.access",
      "insigna.view", "ascenda.view", "accounta.manage"
    ]) {
      db.prepare(
        "INSERT OR IGNORE INTO rbac_role_permissions (role_id, permission_key) VALUES (?, ?)"
      ).run(roleId, perm);
    }
    // Backfill: every current non-super_admin who passes requireAdmin
    // (role='admin' with at least one admin branch) gets the all-modules
    // role — so their effective access is identical post-migration.
    // super_admin is excluded (it bypasses RBAC entirely).
    db.prepare(`
      INSERT OR IGNORE INTO rbac_user_roles (user_id, role_id, assigned_by)
      SELECT u.id, ?, NULL
      FROM users u
      WHERE u.role = 'admin'
        AND EXISTS (
          SELECT 1 FROM user_branches ub
          WHERE ub.user_id = u.id AND ub.is_admin = 1
        )
    `).run(roleId);
  }

  // ── One-time backfill of module permissions added AFTER the initial
  // legacy_admin seed ────────────────────────────────────────────────
  // The seed block above runs only when legacy_admin is first created, so
  // permissions shipped in later releases (e.g. accounta.manage, 2026-06-16,
  // when FEASIBILITY moved behind requirePermission) would never reach
  // existing installs — every current full-admin would silently lose the
  // module. Backfill each new key EXACTLY ONCE (tracked per-key) so a later
  // owner removal in the role UI still sticks across reboots.
  db.exec(`
    CREATE TABLE IF NOT EXISTS rbac_perm_backfills (
      permission_key TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const legacyRoleForBackfill = db.prepare(
    "SELECT id FROM rbac_roles WHERE key = 'legacy_admin'"
  ).get() as { id: number } | undefined;
  if (legacyRoleForBackfill) {
    for (const perm of ["accounta.manage"]) {
      const already = db.prepare(
        "SELECT 1 FROM rbac_perm_backfills WHERE permission_key = ?"
      ).get(perm);
      if (!already) {
        db.prepare(
          "INSERT OR IGNORE INTO rbac_role_permissions (role_id, permission_key) VALUES (?, ?)"
        ).run(legacyRoleForBackfill.id, perm);
        db.prepare(
          "INSERT OR IGNORE INTO rbac_perm_backfills (permission_key) VALUES (?)"
        ).run(perm);
      }
    }
  }

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

    -- Purchase-order edit audit (owner 2026-06-07). When an admin/creator
    -- edits a 'sent' PO (qty change / add / remove line) or sends an
    -- 'approved' PO back for correction, we record who + before/after so
    -- there's a trail. PIN-gated at the API; this is the log half.
    CREATE TABLE IF NOT EXISTS inventa_order_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES inventa_orders(id) ON DELETE CASCADE,
      admin_id INTEGER NOT NULL REFERENCES users(id),
      action TEXT NOT NULL,            -- 'edit' | 'send_back'
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_inventa_order_audit_order
      ON inventa_order_audit(order_id, created_at DESC);
  `);

  // Public share token for the supplier-facing PO PDF (owner 2026-06-08).
  // A random token lets a supplier open the PDF (no login, cost hidden)
  // from a link the owner forwards. Generated lazily on first use.
  {
    const ordCols = new Set(
      (db.prepare("PRAGMA table_info(inventa_orders)").all() as Array<{ name: string }>).map((c) => c.name)
    );
    if (!ordCols.has("public_token")) {
      db.exec("ALTER TABLE inventa_orders ADD COLUMN public_token TEXT");
    }
  }

  // Widen inventa_orders.status to track the full procurement flow (owner
  // 2026-06-08): + 'paid','shipping','returned'; + payment_method ('cash'
  // |'credit'). SQLite can't ALTER a CHECK, so rebuild the table — SAFE
  // pattern (explicit alternations, NOT \b-regex; mirrors the inventa_
  // lookups rebuild). Idempotent: only runs while the old CHECK is live.
  {
    const ordSql = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='inventa_orders'"
    ).get() as { sql: string } | undefined)?.sql ?? "";
    if (ordSql && !ordSql.includes("'shipping'")) {
      // FK is ON (top of file): a DROP TABLE inventa_orders would do an
      // implicit DELETE that CASCADE-deletes inventa_order_lines +
      // inventa_order_audit. Turn FK OFF around the swap (must be OUTSIDE
      // the txn or it's a no-op) — same pattern as the messaging_channels
      // rebuild above. Order ids are preserved so the children stay valid;
      // FK is restored in finally.
      db.exec("PRAGMA foreign_keys = OFF");
      try {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE inventa_orders_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            branch_id INTEGER REFERENCES branches(id),
            status TEXT NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft','sent','approved','paid','shipping','received','returned','cancelled')),
            note TEXT,
            created_by INTEGER REFERENCES users(id),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            sent_at TEXT,
            approved_by INTEGER REFERENCES users(id),
            approved_at TEXT,
            public_token TEXT,
            payment_method TEXT
          );
          INSERT INTO inventa_orders_new
            (id, branch_id, status, note, created_by, created_at, sent_at, approved_by, approved_at, public_token)
            SELECT id, branch_id, status, note, created_by, created_at, sent_at, approved_by, approved_at, public_token
            FROM inventa_orders;
          DROP TABLE inventa_orders;
          ALTER TABLE inventa_orders_new RENAME TO inventa_orders;
          CREATE INDEX IF NOT EXISTS idx_inventa_orders_branch
            ON inventa_orders(branch_id, created_at DESC);
        `);
      })();
      } finally {
        db.exec("PRAGMA foreign_keys = ON");
      }
    }
  }

  // Stock-applied marker (owner 2026-06-11): when a PO is received we add
  // its quantities to on-hand stock exactly once. This timestamp records
  // that it happened so the bump can't be applied twice — and so POs that
  // were already 'received' BEFORE this feature shipped (NULL marker) can
  // be topped up on demand via the "ปรับสต๊อกตามใบนี้" button without
  // double-counting. Standalone idempotent ALTER (runs after the status
  // rebuild above, regardless of its state).
  {
    const ordCols2 = new Set(
      (db.prepare("PRAGMA table_info(inventa_orders)").all() as Array<{ name: string }>).map((c) => c.name)
    );
    if (!ordCols2.has("stock_applied_at")) {
      db.exec("ALTER TABLE inventa_orders ADD COLUMN stock_applied_at TEXT");
    }
  }

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

  // ── 2026-05-31 INVENTA expansion ────────────────────────────
  // Owner direction: catalogue listings were getting dense — adding
  // a short `code` to every taxonomy (categories, locations,
  // suppliers) lets us render two-line cells (CODE big / full name
  // small) and surface filter/sort menus by code. display_order
  // (suppliers) joins the existing inventa_lookups.sort_order in
  // letting admin reorder via ↑↓ buttons in the settings UI.
  //
  // Code is intentionally OPTIONAL — legacy rows pass through with
  // NULL code, the UI falls back to the full name. Once admin opens
  // the row to edit, they're prompted to fill it in.

  // inventa_lookups: code column (kind ∈ {row, storage, unit, category})
  const lookupCols = db.prepare("PRAGMA table_info(inventa_lookups)")
    .all() as Array<{ name: string }>;
  if (!lookupCols.some((c) => c.name === "code")) {
    db.exec("ALTER TABLE inventa_lookups ADD COLUMN code TEXT");
  }

  // inventa_items: cost_price (ราคาทุน) — the owner wanted ราคาทุน
  // tracked explicitly per item, separate from unit_cost (which is the
  // moving avg recomputed on each receipt) and definitely separate
  // from any selling price column. PO totals on the create-PO screen
  // estimate from cost_price (falling back to unit_cost when null).
  if (!invCols.some((c) => c.name === "cost_price")) {
    db.exec("ALTER TABLE inventa_items ADD COLUMN cost_price REAL");
  }

  // inventa_items: pack_unit + pack_size (N5, owner 2026-06-10). An
  // OPTIONAL larger packaging unit + how many smallest-units it holds,
  // e.g. 1 กล่อง = 10 เม็ด. Lets staff count + order in packs while the
  // base quantities (current_qty / order_qty / counted_qty) stay in the
  // smallest unit — pack is purely a data-entry + display convenience,
  // so unit_cost / totals are unaffected. NULL pack_unit or pack_size<=1
  // → the item has no pack concept and everything behaves as before.
  if (!invCols.some((c) => c.name === "pack_unit")) {
    db.exec("ALTER TABLE inventa_items ADD COLUMN pack_unit TEXT");
  }
  if (!invCols.some((c) => c.name === "pack_size")) {
    db.exec("ALTER TABLE inventa_items ADD COLUMN pack_size REAL");
  }

  // inventa_items: fractional-count mode (owner 2026-06-16). For a liquid in
  // a bottle (e.g. anaesthetic) you can't count a discrete unit — staff count
  // "full bottles + % of the open bottle" with a slider. count_mode flags the
  // item; qty_frac holds the on-hand in BOTTLES as a DECIMAL (e.g. 3.2). For
  // such items safety_stock (0-100) is read as "% of one bottle", and the
  // order/receive unit stays whole bottles. Discrete items are completely
  // untouched (count_mode='discrete', qty_frac NULL — the integer current_qty
  // path is unchanged).
  if (!invCols.some((c) => c.name === "count_mode")) {
    db.exec("ALTER TABLE inventa_items ADD COLUMN count_mode TEXT NOT NULL DEFAULT 'discrete'");
  }
  if (!invCols.some((c) => c.name === "qty_frac")) {
    db.exec("ALTER TABLE inventa_items ADD COLUMN qty_frac REAL");
  }

  // inventa_items: reorder mute (owner 2026-06-16). For look-alike/sound-
  // alike substitutes — when a brand isn't in use right now, the staff can
  // mute it so it stops appearing in the "should order" list even when it's
  // below its reorder point. Keeps the reorder list short + un-confusing. The
  // item is otherwise fully active (still counted, still in the catalogue).
  if (!invCols.some((c) => c.name === "reorder_muted")) {
    db.exec("ALTER TABLE inventa_items ADD COLUMN reorder_muted INTEGER NOT NULL DEFAULT 0");
  }

  // inventa_suppliers: code + display_order
  const supplierCols = db.prepare("PRAGMA table_info(inventa_suppliers)")
    .all() as Array<{ name: string }>;
  if (!supplierCols.some((c) => c.name === "code")) {
    db.exec("ALTER TABLE inventa_suppliers ADD COLUMN code TEXT");
  }
  if (!supplierCols.some((c) => c.name === "display_order")) {
    db.exec("ALTER TABLE inventa_suppliers ADD COLUMN display_order INTEGER NOT NULL DEFAULT 100");
  }

  // inventa_counts: reopen tracking (owner 2026-06-03). A submitted
  // count round can be reopened for correction with a PIN; we stamp who
  // did it + when so the round's history is auditable.
  const countCols = db.prepare("PRAGMA table_info(inventa_counts)")
    .all() as Array<{ name: string }>;
  if (!countCols.some((c) => c.name === "reopened_at")) {
    db.exec("ALTER TABLE inventa_counts ADD COLUMN reopened_at TEXT");
  }
  if (!countCols.some((c) => c.name === "reopened_by")) {
    db.exec("ALTER TABLE inventa_counts ADD COLUMN reopened_by INTEGER REFERENCES users(id)");
  }

  // 2026-06-03: configurable ประเภทสินค้า (item_type). Owner wants to
  // add their own types (ยา / เวชภัณฑ์ / อุปกรณ์สำนักงาน …) instead of the
  // hard-coded สินค้า/วัสดุอุปกรณ์.
  //   (a) Widen inventa_lookups.kind CHECK to allow 'item_type'. Safe
  //       rebuild — small config table, no incoming FKs.
  //   (b) Add inventa_items.item_type_label (free-form, lookup-driven).
  //       We DON'T rebuild the core inventa_items table: the legacy
  //       item_type column + its CHECK stay (back-compat); item_type_label
  //       is the new user-facing value.
  const luSql = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='inventa_lookups'"
  ).get() as { sql: string } | undefined)?.sql ?? "";
  if (luSql && !luSql.includes("item_type")) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE inventa_lookups_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          branch_id INTEGER REFERENCES branches(id),
          kind TEXT NOT NULL
            CHECK (kind IN ('row','storage','unit','category','item_type')),
          value TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 100,
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          code TEXT
        );
        INSERT INTO inventa_lookups_new
          (id, branch_id, kind, value, sort_order, active, created_at, code)
          SELECT id, branch_id, kind, value, sort_order, active, created_at, code
          FROM inventa_lookups;
        DROP TABLE inventa_lookups;
        ALTER TABLE inventa_lookups_new RENAME TO inventa_lookups;
        CREATE INDEX IF NOT EXISTS idx_inventa_lookups_kind
          ON inventa_lookups(kind, active);
      `);
    })();
  }
  const invCols2 = db.prepare("PRAGMA table_info(inventa_items)")
    .all() as Array<{ name: string }>;
  if (!invCols2.some((c) => c.name === "item_type_label")) {
    db.exec("ALTER TABLE inventa_items ADD COLUMN item_type_label TEXT");
    db.exec(`
      UPDATE inventa_items
      SET item_type_label = CASE item_type
            WHEN 'equipment' THEN 'วัสดุอุปกรณ์' ELSE 'สินค้า' END
      WHERE item_type_label IS NULL
    `);
  }
  // Seed each branch's default item types (idempotent).
  db.exec(`
    INSERT INTO inventa_lookups (branch_id, kind, value, sort_order)
    SELECT b.id, 'item_type', v.val, v.ord
    FROM branches b
    CROSS JOIN (SELECT 'สินค้า' AS val, 10 AS ord UNION ALL SELECT 'วัสดุอุปกรณ์', 20) v
    WHERE NOT EXISTS (
      SELECT 1 FROM inventa_lookups l WHERE l.branch_id = b.id AND l.kind = 'item_type'
    )
  `);

  // inventa_item_lots — per-receipt lot tracking with expiry.
  // Multi-lot per item so the clinic can spot "Vitamin B is overstocked
  // because lot A expires next month AND lot B was just received".
  // Pragmatic v1 choice: lots track receipts + expiry; current_qty on
  // inventa_items remains the source of truth for "how much do we have"
  // (lots don't enforce sum). Operationally this matches how the team
  // counts: they count totals, not per-lot, so anchoring to current_qty
  // avoids breaking the existing count flow.
  //
  // expiry_date is YYYY-MM-DD (date-only). qty is per smallest unit
  // (same scale as items.current_qty). lot_number is admin-typed; not
  // unique (different items can share a lot number from the same
  // supplier).
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventa_item_lots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES inventa_items(id) ON DELETE CASCADE,
      lot_number TEXT,
      expiry_date TEXT,
      qty INTEGER NOT NULL DEFAULT 0,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      note TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_inventa_item_lots_item
      ON inventa_item_lots(item_id);
    CREATE INDEX IF NOT EXISTS idx_inventa_item_lots_expiry
      ON inventa_item_lots(expiry_date) WHERE expiry_date IS NOT NULL;

    -- Cost-change audit (owner F6 2026-06-07): every time a goods receipt
    -- changes an item's cost price we record old→new + who/when, so the
    -- owner can trace why a cost moved. source='receive' for the lot/
    -- receiving flow; room for other sources later.
    CREATE TABLE IF NOT EXISTS inventa_cost_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES inventa_items(id) ON DELETE CASCADE,
      old_cost REAL,
      new_cost REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'receive',
      lot_id INTEGER,
      changed_by INTEGER REFERENCES users(id),
      changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_inventa_cost_changes_item
      ON inventa_cost_changes(item_id, changed_at DESC);
  `);

  // Per-receipt cost paid (owner F6 2026-06-07). PRAGMA-guarded ALTER —
  // CREATE TABLE IF NOT EXISTS above never adds a column to an existing
  // lots table.
  {
    const lotCols = new Set(
      (db.prepare("PRAGMA table_info(inventa_item_lots)").all() as Array<{ name: string }>)
        .map((c) => c.name)
    );
    if (!lotCols.has("unit_cost")) db.exec("ALTER TABLE inventa_item_lots ADD COLUMN unit_cost REAL");
  }

  // Branches gain an idempotency stamp for the daily INVENTA expiry
  // alert (#92). Same once-per-day-per-branch pattern as the
  // attendance summary — the cron tick checks the stored date vs
  // today and short-circuits when they match.
  const bnamesInv = db.prepare("PRAGMA table_info(branches)")
    .all() as Array<{ name: string }>;
  if (!bnamesInv.some((c) => c.name === "inventa_expiry_alert_last_sent_date")) {
    db.exec("ALTER TABLE branches ADD COLUMN inventa_expiry_alert_last_sent_date TEXT");
  }

  // INVENTA ships with NO preset lookups. Each business defines its
  // own categories / units / storage locations / colour-band meaning
  // from /staff/inventa/settings, so the dropdowns start empty rather
  // than pre-filled with clinic-specific values. (Existing installs
  // that still carry the old seed clear it via the super_admin
  // "ล้างข้อมูล INVENTA" tool — see /api/inventa/admin/reset.)

  // ── RECRUITA — recruitment module (2026-05-31, Phase 0) ──────
  // Standalone module: applicants come through a separate LINE OA
  // ("IKIGAI RECRUIT") and don't touch the main users table until
  // hire. Once admin clicks "รับเข้าทำงาน" on an application, a
  // bridge transaction creates the PERSONA users row + carries
  // every field listed in EmployeeProfile (1:1 map → no re-entry).
  //
  // Table layout:
  //   recruita_positions     — open positions admin maintains
  //   recruita_candidates    — one row per real person (deduped by
  //                              national_id or email+phone)
  //   recruita_applications  — one row per (candidate × position)
  //                              attempt; this is where stage lives
  //   recruita_documents     — encrypted file refs (photo / resume /
  //                              ID copy / education cert / …)
  //
  // Per-position custom questions live on positions.custom_questions
  // as JSON; answers on applications.custom_answers as JSON. Four
  // types supported: text / single / multi / rating — admin defines
  // the shape, the LIFF form renders dynamically.
  db.exec(`
    CREATE TABLE IF NOT EXISTS recruita_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER REFERENCES branches(id),
      code TEXT,                    -- optional short code, e.g. "BAR-01"
      title TEXT NOT NULL,          -- public-facing title
      department TEXT,
      employment_type TEXT,         -- 'ft' | 'pt' | 'contract'
      jd_summary TEXT,              -- one-liner shown on listing
      jd_full TEXT,                 -- full markdown JD on detail page
      requirements TEXT,            -- markdown/free text
      benefits TEXT,                -- markdown/free text
      salary_min REAL,
      salary_max REAL,
      vacancies INTEGER NOT NULL DEFAULT 1,
      /** JSON array of custom questions admin defined for this role.
       *  Shape: [{ id, order, required, type, label, hint?, config? }]
       *  type ∈ 'text'|'single'|'multi'|'rating'.
       *  config carries type-specific fields (options, scale, etc.). */
      custom_questions TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'closed' | 'draft'
      opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_recruita_positions_status
      ON recruita_positions(status, branch_id);
  `);
  // 2026-06-01 — salary_type column on recruita_positions. Owner needs
  // to advertise hourly / daily / monthly rates because PT roles
  // (FOH part-timers, kitchen cover shifts) are paid hourly while
  // career positions are monthly. salary_min/max stay as numeric;
  // this column drives the unit label in the listing card.
  // 'monthly' is the default for backward compat — existing rows
  // were all monthly when only one type was supported.
  const rpCols = db.prepare("PRAGMA table_info(recruita_positions)").all() as Array<{ name: string }>;
  if (!rpCols.some((c) => c.name === "salary_type")) {
    db.exec("ALTER TABLE recruita_positions ADD COLUMN salary_type TEXT NOT NULL DEFAULT 'monthly'");
  }
  db.exec(`

    CREATE TABLE IF NOT EXISTS recruita_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      /** Deduplication key — sha256(national_id) when provided, else
       *  sha256(lower(email)+normalized_phone). Lets us recognise the
       *  same person applying to multiple positions without revealing
       *  their PII in queries. */
      dedupe_hash TEXT,
      /** LINE userId of the applicant once they enter via LIFF.
       *  NULL for web-form applicants (Phase 0). */
      line_user_id TEXT,
      -- Personal (matches EmployeeProfile shape so bridge is direct)
      title_prefix TEXT,
      first_name_th TEXT,
      last_name_th TEXT,
      first_name_en TEXT,
      last_name_en TEXT,
      nickname_th TEXT,
      nickname_en TEXT,
      dob TEXT,                      -- YYYY-MM-DD
      gender TEXT,                   -- 'male' | 'female'
      nationality TEXT,
      marital_status TEXT,
      military_status TEXT,
      religion TEXT,
      /** Encrypted via secret-vault (enc:v1:…). Plaintext never
       *  hits the DB — see secret-vault.ts. */
      national_id_encrypted TEXT,
      -- Contact
      personal_email TEXT,
      mobile_phone TEXT,
      line_id TEXT,
      house_address TEXT,
      house_subdistrict TEXT,
      house_district TEXT,
      house_province TEXT,
      house_postcode TEXT,
      contact_address TEXT,
      contact_subdistrict TEXT,
      contact_district TEXT,
      contact_province TEXT,
      contact_postcode TEXT,
      contact_same_as_house INTEGER NOT NULL DEFAULT 1,
      emergency_name TEXT,
      emergency_relationship TEXT,
      emergency_phone TEXT,
      -- Structured history (JSON arrays — flexible row counts)
      /** [{ level, institution, faculty, major, year_finished, gpa }] */
      education_json TEXT NOT NULL DEFAULT '[]',
      /** [{ company, position, started, ended, salary, reason_left }] */
      experience_json TEXT NOT NULL DEFAULT '[]',
      /** [{ language, level }] — e.g. {language:'TH', level:'native'} */
      skills_language_json TEXT NOT NULL DEFAULT '[]',
      /** Free-form list, one per line */
      skills_other TEXT,
      /** [{ name, relationship, phone }] — required 2 by convention */
      references_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_recruita_candidates_dedupe
      ON recruita_candidates(dedupe_hash) WHERE dedupe_hash IS NOT NULL;
    -- idx_recruita_candidates_line is created as a UNIQUE index in a
    -- dedup-first migration after this block (RC-2, owner 2026-06-13) —
    -- it can't be inline because existing rows may share a userId and a
    -- UNIQUE create would throw at boot before the dedup runs.

    CREATE TABLE IF NOT EXISTS recruita_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL REFERENCES recruita_candidates(id) ON DELETE CASCADE,
      position_id INTEGER NOT NULL REFERENCES recruita_positions(id),
      /** Lifecycle stage. Phase 0 only writes 'applied'; later phases
       *  advance via the kanban + bridge. */
      stage TEXT NOT NULL DEFAULT 'applied',
        -- 'applied' | 'screening' | 'interview' | 'offered'
        -- | 'accepted' | 'hired' | 'rejected' | 'withdrawn'
      expected_salary REAL,
      earliest_start_date TEXT,
      why_join TEXT,               -- free-text "ทำไมอยากร่วมงาน"
      /** JSON object — { [questionId]: answerValue }. answerValue type
       *  follows the question type: string for text/single, string[]
       *  for multi, number for rating. */
      custom_answers TEXT NOT NULL DEFAULT '{}',
      /** PDPA: consent timestamp + originating IP. Required to submit. */
      consent_at TEXT,
      consent_ip TEXT,
      consent_user_agent TEXT,
      /** When the bridge fires, hired_user_id points at the new
       *  users row so we can navigate from RECRUITA → PERSONA. */
      hired_user_id INTEGER REFERENCES users(id),
      hired_at TEXT,
      hired_by INTEGER REFERENCES users(id),
      submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_recruita_applications_stage
      ON recruita_applications(stage, position_id);
    CREATE INDEX IF NOT EXISTS idx_recruita_applications_candidate
      ON recruita_applications(candidate_id);

    CREATE TABLE IF NOT EXISTS recruita_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL REFERENCES recruita_candidates(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,            -- 'photo' | 'resume' | 'id_copy' | 'education_cert' | 'house_reg' | 'other'
      original_filename TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      /** Path on disk under /var/www/reserva/data/recruita/<candidateId>/
       *  Filename is randomised so URL guessing fails. */
      stored_path TEXT NOT NULL,
      uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_recruita_documents_candidate
      ON recruita_documents(candidate_id, kind);

    -- 2026-06-01 OA follower tracker. Plain table of userId + the
    -- channel scope they followed, with a timestamp. Two complementary
    -- recency-link paths:
    --   (a) candidate adds OA AFTER applying → existing follow-event
    --       path matches them to the most-recent unlinked candidate row
    --   (b) candidate adds OA BEFORE applying → this table lets the
    --       application-submit path find their userId and link
    -- Rows expire 30 days after follow (PDPA — we don't need the
    -- linkage info forever).
    CREATE TABLE IF NOT EXISTS line_oa_recent_followers (
      line_user_id TEXT NOT NULL,
      channel_scope TEXT NOT NULL,
      followed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      consumed_at TEXT,
      PRIMARY KEY (line_user_id, channel_scope)
    );
    CREATE INDEX IF NOT EXISTS idx_line_followers_recent
      ON line_oa_recent_followers(channel_scope, followed_at)
      WHERE consumed_at IS NULL;

    -- 2026-06-01 Dual-admin approval for RECRUITA stage transitions.
    -- Owner wanted: every stage change on a candidate's application
    -- requires TWO different admin users to approve, each entering
    -- their own PIN. The first admin's click no longer commits the
    -- change — it just opens a "pending" request that the second
    -- admin must approve. Prevents both fat-finger drops and
    -- single-actor abuse (e.g. one admin secretly rejecting a
    -- candidate they don't like).
    --
    -- Lifecycle:
    --   requested → approved      (stage committed, notification fires)
    --   requested → cancelled    (admin1 or any super_admin aborts)
    --   requested → expired      (24h passed without 2nd approval)
    CREATE TABLE IF NOT EXISTS recruita_stage_change_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES recruita_applications(id) ON DELETE CASCADE,
      from_stage TEXT NOT NULL,
      to_stage TEXT NOT NULL,
      requested_by INTEGER NOT NULL REFERENCES users(id),
      requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      approver_user_id INTEGER REFERENCES users(id),
      approver_at TEXT,
      cancelled_by INTEGER REFERENCES users(id),
      cancelled_at TEXT,
      cancel_reason TEXT,
      /** 24h soft-expire — a request that's been sitting too long is
       *  probably stale (interviewer left, plan changed). Status flips
       *  to 'expired' at read time; admin can re-create. */
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','cancelled','expired'))
    );
    CREATE INDEX IF NOT EXISTS idx_recruita_stagereq_app
      ON recruita_stage_change_requests(application_id, status);
    CREATE INDEX IF NOT EXISTS idx_recruita_stagereq_pending
      ON recruita_stage_change_requests(status, expires_at)
      WHERE status = 'pending';

    -- 2026-06-09 Self-service interview scheduling. The admin defines a
    -- pool of bookable 1-hour slots (generated from selected weekdays ×
    -- a date range × a daily time window). An applicant whose
    -- application reached the 'interview' stage picks an OPEN slot on
    -- the public status page; booking is first-come-first-served.
    --
    -- Concurrency is guarded by a CONDITIONAL update
    --   UPDATE ... SET status='booked' WHERE id=? AND status='open'
    -- and checking changes()===1 — NOT by relying on a UNIQUE over a
    -- nullable column (SQLite treats NULLs as distinct, per CLAUDE.md).
    -- booked_application_id ON DELETE SET NULL: if the linked
    -- application is later purged (PDPA) the slot is reclaimed by the
    -- "orphan sweep" (status='booked' AND booked_application_id IS NULL
    -- → back to 'open') in recruita-interview-slots.ts.
    CREATE TABLE IF NOT EXISTS recruita_interview_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_date TEXT NOT NULL,        -- 'YYYY-MM-DD' Bangkok-local
      start_time TEXT NOT NULL,       -- 'HH:MM' 24h
      end_time TEXT NOT NULL,         -- 'HH:MM'
      location TEXT,                  -- optional venue text
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','booked')),
      booked_application_id INTEGER REFERENCES recruita_applications(id) ON DELETE SET NULL,
      booked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (slot_date, start_time)
    );
    CREATE INDEX IF NOT EXISTS idx_recruita_slots_date
      ON recruita_interview_slots(slot_date, status);
    CREATE INDEX IF NOT EXISTS idx_recruita_slots_booked
      ON recruita_interview_slots(booked_application_id);
  `);

  // RC-2 (owner 2026-06-13) — one LINE account per candidate. The removed
  // phone-search bind (RC-1) let the same line_user_id sit on multiple
  // candidate rows, so one person's notifications reached another. Step 1:
  // dedup — NULL the binding on EVERY row of any duplicated userId (we don't
  // guess which is the real owner; an admin re-links via the unlinked list).
  // Step 2: a partial UNIQUE index so any future cross-bind fails loudly.
  // Dedup-before-constraint + IF NOT EXISTS = idempotent and boot-safe; this
  // never throws on existing data the way an inline UNIQUE create would.
  db.prepare(`
    UPDATE recruita_candidates
    SET line_user_id = NULL, updated_at = datetime('now')
    WHERE line_user_id IN (
      SELECT line_user_id FROM recruita_candidates
      WHERE line_user_id IS NOT NULL
      GROUP BY line_user_id HAVING COUNT(*) > 1
    )
  `).run();
  db.exec(`
    DROP INDEX IF EXISTS idx_recruita_candidates_line;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_recruita_candidates_line
      ON recruita_candidates(line_user_id) WHERE line_user_id IS NOT NULL;
  `);

  // 2026-06-10 Stage-change requests no longer expire (owner). Resurrect
  // any request that the old 24h TTL already auto-expired so a second
  // admin can still approve it. Safe + effectively one-time: once the
  // no-expiry code is live, no new 'expired' rows are ever created.
  db.exec("UPDATE recruita_stage_change_requests SET status = 'pending' WHERE status = 'expired'");

  // 2026-06-11 (owner): clear STALE pending stage-change requests. Under the
  // old "every move needs 2 admins" rule, applications got moved by other
  // means while a request lingered — so the pipeline still shows a redundant
  // "รออนุมัติเปลี่ยนสถานะ" tag even though the card already sits in the new
  // column. A pending request whose from_stage no longer matches the
  // application's CURRENT stage can never be validly approved anyway
  // (approveStageRequest rejects it as 'stage_changed_under_us'), so cancel
  // it and let the card just reflect its current column. Idempotent — once
  // cancelled the row is no longer 'pending'.
  db.exec(`
    UPDATE recruita_stage_change_requests
       SET status = 'cancelled',
           cancelled_at = CURRENT_TIMESTAMP,
           cancel_reason = 'ระบบยกเลิกอัตโนมัติ: ใบสมัครเปลี่ยนสถานะไปแล้ว (ปรับเกณฑ์อนุมัติ 2026-06-11)'
     WHERE status = 'pending'
       AND from_stage <> (
         SELECT a.stage FROM recruita_applications a WHERE a.id = application_id
       )
  `);

  // 2026-06-01 NOTE — an earlier draft of this migration added
  //   users.admin_pin_hash + admin_pin_set_at + admin_pin_failed_attempts
  //   + admin_pin_locked_until
  // for a separate "admin PIN" gating RECRUITA stage approvals. The
  // owner correctly pointed out that users.pin_hash already exists
  // (4-digit time-clock PIN) and reusing it is the right call. The
  // dead columns survive on prod from the deploy of commit 054ed55 —
  // harmless. New databases skip them entirely. lib/admin-pin.ts now
  // reads users.pin_hash directly.

  // ── 2026-05-31 RECRUITA additive fields ──────────────────────
  // Surfaced after reviewing the owner's existing Google Form
  // ("ระบบให้ข้อมูลสำหรับสมัครงานออนไลน์", 191 responses). These
  // are universal (apply to every position) so they live on the
  // canonical tables. Role-specific things like "หัตถการทางการ
  // แพทย์" stay as per-position custom_questions JSON instead.
  //
  // Split rationale:
  //   • candidate-level → identity / lifestyle / history that
  //     follows the person across positions
  //   • application-level → answers about THIS specific job
  //     attempt (e.g., expected income for this role, where
  //     they heard about THIS opening, truth declaration tied
  //     to THIS submission)
  const cCols = db.prepare("PRAGMA table_info(recruita_candidates)")
    .all() as Array<{ name: string }>;
  const addCandidate = (col: string, ddl: string) => {
    if (!cCols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE recruita_candidates ADD COLUMN ${col} ${ddl}`);
    }
  };
  // Distinct from `nationality` (สัญชาติ vs เชื้อชาติ on the form)
  addCandidate("race", "TEXT");
  // 'family' | 'own_home' | 'rental' | 'dormitory' | 'other'
  addCandidate("housing_type", "TEXT");
  // 'has_license' | 'no_license' | 'not_applicable' — for nurse /
  // medical-tech / public-health roles only
  addCandidate("professional_license_status", "TEXT");
  // 0/1 from "เคยป่วยหนัก/โรคติดต่อร้ายแรงมาก่อนหรือไม่"
  addCandidate("prior_illness", "INTEGER");
  addCandidate("prior_illness_detail", "TEXT");
  // "ถ้าเคยสมัครกับบริษัทมาก่อน เคยสมัครเมื่อไหร่"
  addCandidate("prior_application_at", "TEXT");
  // "เขียนชื่อ/โทร/อาชีพของผู้อ้างถึง 1 คน (ไม่ใช่ญาติ/นายจ้าง)"
  addCandidate("referee_external_text", "TEXT");

  const aCols = db.prepare("PRAGMA table_info(recruita_applications)")
    .all() as Array<{ name: string }>;
  const addApplication = (col: string, ddl: string) => {
    if (!aCols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE recruita_applications ADD COLUMN ${col} ${ddl}`);
    }
  };
  // "ทราบข่าวสารการสมัครจากช่องทางใด"
  addApplication("info_source", "TEXT");
  // 0/1 from "สามารถไปปฏิบัติงานต่างจังหวัดได้หรือไม่"
  addApplication("can_travel", "INTEGER");
  // "คุณมีความคาดหวัง/เป้าหมายอะไรกับการสมัครเข้ามาทำงานกับเรา"
  addApplication("goals", "TEXT");
  // 0/1 — Section 8 of the form, "ยอมรับ รับรองความถูกต้อง"
  addApplication("truth_declaration_accepted", "INTEGER");
  // Snapshot of last work experience pulled out of the JSON for
  // pipeline filtering (admin often wants "applicants whose last
  // role was X" without parsing JSON in SQL).
  addApplication("last_workplace", "TEXT");
  addApplication("last_position", "TEXT");
  addApplication("last_tenure", "TEXT");
  addApplication("last_salary", "TEXT");
  addApplication("last_reason_left", "TEXT");
  // Interview scheduling (2026-06-02). interview_at is a NAIVE Bangkok
  // local datetime "YYYY-MM-DDTHH:MM" (same convention as bookings — no
  // timezone), set by admin from a datetime-local picker. location/note
  // are free text shown to the candidate in the scheduling push.
  addApplication("interview_at", "TEXT");
  addApplication("interview_location", "TEXT");
  addApplication("interview_note", "TEXT");

  // Post-interview health check (2026-06-04). After the interview the
  // candidate must clear a medical check before they can be hired — they
  // bring their own certificate OR get tested at AT HOME CLINIC, and the
  // admin records the outcome here. The result file (if any) is stored in
  // recruita_documents with kind='health_result'. Hiring is blocked until
  // health_check_status = 'passed'.
  addApplication("health_check_status", "TEXT");    // 'pending' | 'passed' | 'failed'
  addApplication("health_check_provider", "TEXT");  // 'self' | 'at_home'
  addApplication("health_check_at", "TEXT");         // 'YYYY-MM-DD'
  addApplication("health_check_note", "TEXT");
  addApplication("health_checked_by", "INTEGER");    // users.id who recorded it

  // First work day, set when the admin moves the application to 'offered'
  // (owner 2026-06-15). Captured in a popup at offer time and shown on the
  // offer card pushed to the candidate. 'YYYY-MM-DD' (Bangkok date).
  addApplication("offer_start_date", "TEXT");
  // Offered compensation (owner 2026-06-15) — shown on the offer card so the
  // candidate can accept/reject an informed offer. offer_salary_type =
  // 'monthly' | 'hourly'. Defaults the hire-bridge salary fields later.
  addApplication("offer_salary", "REAL");
  addApplication("offer_salary_type", "TEXT");   // 'monthly' | 'hourly'
  // Per-candidate special conditions, typed at offer time (owner 2026-06-17).
  // Free text shown on the offer card + the candidate's status page. NULL =
  // none (card omits the section).
  addApplication("offer_conditions", "TEXT");
  // Admin-confirmed interview appointment (owner 2026-06-17). Once 1, the
  // candidate can no longer reschedule/cancel their interview. Independent
  // of the day-of lock (a confirmed future appointment is also frozen).
  addApplication("interview_confirmed", "INTEGER");  // 0/1, NULL = not confirmed

  // Walk-in visits (added 2026-05-24) — staff records anyone who walks
  // in without a booking. Mirrors a slice of `bookings`: phone is the
  // identity key used to decide "first-time vs returning". Walk-ins
  // also qualify for the free-ice-cream promo when first-time, so they
  // carry the same verification_code + redemption_status enum as
  // bookings — staff scans / shows the code at handoff. ASCENDA reads
  // this table to credit the staff member who took the entry.
  //   guest_name        — short label only ("คุณ A", "ลูกค้าผู้ชาย").
  //                        Not PDPA-sensitive on its own; phone is.
  //   party_size        — adults + kids combined, single integer.
  //   phone             — required so we can match first-time across
  //                        bookings + walk_in_visits. Hashed lookup
  //                        is fine (we just need equality).
  //   first_time        — snapshot at insert time (1/0). Determines
  //                        redemption_status default.
  //   recorded_by_user_id — the staff who keyed the row. ASCENDA
  //                        scoring credits this user.
  db.exec(`
    CREATE TABLE IF NOT EXISTS walk_in_visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      visited_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      guest_name TEXT,
      phone TEXT,
      party_size INTEGER NOT NULL DEFAULT 1,
      table_id INTEGER REFERENCES tables(id),
      occasion TEXT,
      notes TEXT,
      first_time INTEGER NOT NULL DEFAULT 0,
      verification_code TEXT,
      redemption_status TEXT,
      redeemed_at TEXT,
      redeemed_by_user_id INTEGER REFERENCES users(id),
      recorded_by_user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_walk_in_visits_branch_date
      ON walk_in_visits(branch_id, visited_at);
    CREATE INDEX IF NOT EXISTS idx_walk_in_visits_phone
      ON walk_in_visits(phone) WHERE phone IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_walk_in_visits_code
      ON walk_in_visits(verification_code)
      WHERE verification_code IS NOT NULL;
  `);

  // Staff credits ledger (added 2026-05-24) — append-only log of every
  // ASCENDA-eligible action a staff member performs. Today it only
  // tracks "captured a first-time customer" but the enum will expand
  // (closing-task on-time, no missed clock-ins, etc) once ASCENDA
  // scoring goes live. Stored as a separate table (not a column on
  // walk_in_visits / bookings) so future credit kinds that aren't
  // tied to a single source row still fit cleanly.
  //   kind              — 'first_time_capture' for now. Open enum,
  //                        validated in the API layer not the DB so
  //                        new kinds don't need a migration.
  //   points            — integer score delta (positive = earned).
  //                        Default 1; future weights set per-kind in
  //                        application code.
  //   ref_table/ref_id  — the row that triggered the credit. NULL
  //                        when admin-granted manually.
  db.exec(`
    CREATE TABLE IF NOT EXISTS staff_credits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      branch_id INTEGER REFERENCES branches(id),
      kind TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 1,
      ref_table TEXT,
      ref_id INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_staff_credits_user
      ON staff_credits(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_staff_credits_kind
      ON staff_credits(kind, created_at);
  `);

  // ── ASCENDA — KPI / OKR evaluation (2026-05-27) ────────────────────
  //
  // Three tables drive the module:
  //   ascenda_kpis            — the criteria definitions admin can
  //                              add/remove/reweight. `kind` selects
  //                              which calculator (or "manual") feeds
  //                              the actual value; `scope` decides
  //                              whether each branch gets its own
  //                              evaluation or one company-wide row.
  //   ascenda_results         — one row per (kpi, branch?, period).
  //                              period_key = "YYYY-MM" for monthly
  //                              progression; quarter/year summaries
  //                              are aggregated on the fly from these.
  //   branch_daily_revenue    — daily revenue input, fed from the
  //                              shift_close checklist (Phase 3) plus
  //                              manual admin edits. Used by the
  //                              auto-calculated COL % and sales
  //                              growth % KPIs.
  //
  // Owner direction (2026-05-27):
  //   • Per-KPI scope (branch vs company) — some KPIs evaluated per
  //     branch (attendance, accidents, COG, COL), some aggregated
  //     company-wide (sales growth).
  //   • Monthly progression with quarter + year rollups computed at
  //     view time (no separate quarter/year rows in the DB).
  //   • Weighted scoring: each branch's monthly score = Σ (kpi_weight
  //     × pass?1:0) ÷ Σ kpi_weight × 100. Display as percentage.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ascenda_kpis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL CHECK (scope IN ('branch','company')),
      kind TEXT NOT NULL,
      -- Enum identifying calculator + data source:
      --   'attendance_pct'    auto from time_entries + leave_requests
      --   'incident_count'    manual count
      --   'wrong_order_count' manual count
      --   'complaint_count'   manual count
      --   'cog_pct'           manual percentage
      --   'col_pct_auto'      auto from roster × rate ÷ rev_avg_3m
      --   'sales_growth_pct'  auto from monthly revenue
      --   'manual_number'     generic numeric (admin enters)
      --   'manual_pct'        generic percentage (admin enters)
      title TEXT NOT NULL,
      description TEXT,
      unit TEXT,
      -- '%', 'ครั้ง', 'บาท' — display suffix only.
      target_value REAL,
      target_op TEXT CHECK (target_op IN ('lte','gte','eq')),
      -- lte = actual ≤ target = pass (cost/error caps)
      -- gte = actual ≥ target = pass (sales growth)
      weight INTEGER NOT NULL DEFAULT 1,
      -- Higher = counts more toward the rolled-up branch score.
      display_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      updated_by INTEGER REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_ascenda_kpis_scope_active
      ON ascenda_kpis (scope, active, display_order);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ascenda_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kpi_id INTEGER NOT NULL REFERENCES ascenda_kpis(id) ON DELETE CASCADE,
      branch_id INTEGER REFERENCES branches(id) ON DELETE CASCADE,
      -- NULL for company-scope KPIs; non-null for branch-scope rows.
      period_key TEXT NOT NULL,
      -- YYYY-MM (e.g. "2026-05"). Quarter/year views aggregate these.
      actual_value REAL,
      status TEXT CHECK (status IN ('pass','fail','na','pending')),
      notes TEXT,
      computed_by_system INTEGER NOT NULL DEFAULT 0,
      -- 1 = auto-filled by the engine (attendance/COL/sales) and so
      --     the row regenerates when source data changes
      -- 0 = manual entry (incidents/complaints/orders/COG) — engine
      --     leaves these alone unless admin clears them first.
      recorded_by INTEGER REFERENCES users(id),
      recorded_at TEXT,
      UNIQUE (kpi_id, branch_id, period_key)
    );
    CREATE INDEX IF NOT EXISTS idx_ascenda_results_period
      ON ascenda_results (period_key);
    CREATE INDEX IF NOT EXISTS idx_ascenda_results_branch_period
      ON ascenda_results (branch_id, period_key);
  `);
  // company_id (2026-05-27 owner direction): company-scope KPIs
  // evaluated PER company, not aggregated to one global row. Owner
  // wording: "ASCENDA มีผลกับทุกบริษัท ทุกสาขา แต่ให้พิจารณาแยกกัน"
  // — every company + every branch is in scope, but evaluated
  // separately. Branch-scope rows already split per branch; this
  // column lets company-scope rows split per company.
  //   branch-scope row → branch_id set, company_id NULL
  //   company-scope row → branch_id NULL, company_id set
  // Uniqueness is enforced manually in the upsert path (NULL ≠ NULL
  // in SQLite UNIQUE means the inline constraint above wouldn't
  // dedupe company-scope rows across companies — the lookup-first
  // pattern in the API/engine handles it without a table rebuild).
  const arCols = db.prepare("PRAGMA table_info(ascenda_results)").all() as Array<{ name: string }>;
  if (!arCols.some((c) => c.name === "company_id")) {
    db.exec("ALTER TABLE ascenda_results ADD COLUMN company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ascenda_results_company_period ON ascenda_results (company_id, period_key)");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS branch_daily_revenue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      revenue REAL NOT NULL,
      recorded_by INTEGER REFERENCES users(id),
      recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      source TEXT,
      -- 'shift_close' (set by Phase 3 hook) | 'admin_edit' | NULL.
      UNIQUE (branch_id, date)
    );
    CREATE INDEX IF NOT EXISTS idx_branch_revenue_branch_date
      ON branch_daily_revenue (branch_id, date);
  `);

  // Seed the 7 default KPIs the owner specified. Idempotent — only
  // inserts when ascenda_kpis is empty so editing/removing seeded
  // rows in production doesn't bring them back on next boot.
  const kpiCount = (db.prepare(
    "SELECT COUNT(*) AS n FROM ascenda_kpis"
  ).get() as { n: number }).n;
  if (kpiCount === 0) {
    const ins = db.prepare(`
      INSERT INTO ascenda_kpis
        (scope, kind, title, description, unit, target_value, target_op, weight, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // Branch-scope KPIs (1-6) — each branch evaluated separately.
    ins.run("branch", "attendance_pct", "อัตราการขาด/ลา/มาสาย",
      "เปอร์เซ็นต์ของชั่วโมงที่ทีมขาด ลา หรือมาสาย เทียบกับชั่วโมงที่วางแผนไว้",
      "%", 10, "lte", 2, 1);
    ins.run("branch", "incident_count", "อุบัติเหตุในที่ทำงาน",
      "จำนวนครั้งของอุบัติเหตุที่เกิดขึ้นในที่ทำงาน รวมพนักงานบาดเจ็บและทรัพย์สินเสียหาย",
      "ครั้ง", 0, "lte", 3, 2);
    ins.run("branch", "wrong_order_count", "ออเดอร์ผิด / ปฏิเสธลูกค้า",
      "จำนวนครั้งของออเดอร์ที่ทำผิดสเป็คหรือปฏิเสธคำสั่งของลูกค้า",
      "ครั้ง", 0, "lte", 2, 3);
    ins.run("branch", "complaint_count", "ข้อร้องเรียนจากลูกค้า",
      "จำนวนข้อร้องเรียนที่เข้ามาจากลูกค้าทุกช่องทาง (LINE / Google / ฯลฯ)",
      "ครั้ง", 0, "lte", 2, 4);
    ins.run("branch", "cog_pct", "ต้นทุนวัตถุดิบ (COG)",
      "Cost of Goods — เปอร์เซ็นต์ของต้นทุนวัตถุดิบเทียบกับยอดขาย เป้า ≤ 35%",
      "%", 35, "lte", 2, 5);
    ins.run("branch", "col_pct_auto", "ต้นทุนแรงงาน (COL)",
      "Cost of Labour — คำนวณอัตโนมัติจากชั่วโมงตามตารางเวร × ค่าตอบแทน ÷ รายได้เฉลี่ย 3 เดือนหลังสุด เป้า ≤ 20%",
      "%", 20, "lte", 2, 6);
    // Company-scope KPI (7) — one evaluation across all branches.
    ins.run("company", "sales_growth_pct", "ยอดขายเฉลี่ยโต",
      "เปรียบเทียบยอดขายเฉลี่ยรายเดือนกับเดือนก่อนหน้า เป้า ≥ 20%",
      "%", 20, "gte", 3, 7);
  }

  // ── INSIGNA (2026-05-30) ────────────────────────────────────
  // Privacy-first marketing intelligence engine. Lives in-process
  // (Mode A from spec section 2) — same Next.js, same SQLite file,
  // but logically isolated:
  //   - Tables prefixed `insigna_*` so the PII lint below can
  //     scan them in isolation and refuse the migration if any
  //     forbidden column slips in.
  //   - Hash salt (INSIGNA_SALT) read from env in lib/insigna/hash.ts
  //     — NEVER referenced from booking code, enforced by code
  //     organization rather than process boundary.
  //   - Foreign keys are intra-INSIGNA only. We do NOT reference
  //     users.id, bookings.id, etc. — pseudonymity must survive
  //     even an "insigna_* only" leak.
  //
  // See INSIGNA spec sections 3 + 6 for the full data model + privacy
  // requirements. The CREATE TABLE blocks below mirror sections 3.1
  // through 3.13 verbatim.
  db.exec(`
    -- 3.1 Customer (pseudonymous profile). customer_hash is the
    -- 64-char hex output of HMAC-SHA256(line_user_id OR phone,
    -- INSIGNA_SALT). No PII columns — PII lives in the booking
    -- system (users table). NEVER add name/phone/email/dob here.
    CREATE TABLE IF NOT EXISTS insigna_customers (
      customer_hash         TEXT PRIMARY KEY,
      birth_year            INTEGER,
      gender                TEXT CHECK (gender IN ('M','F','X')),
      consent_marketing     INTEGER NOT NULL DEFAULT 0,
      consent_analytics     INTEGER NOT NULL DEFAULT 0,
      acquisition_source    TEXT,
      acquisition_campaign  TEXT,
      acquisition_date      TEXT,
      created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_visit_at         TEXT,
      total_visits          INTEGER NOT NULL DEFAULT 0,
      persona_tag           TEXT,
      churn_risk_score      REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_insigna_customers_persona ON insigna_customers(persona_tag);
    CREATE INDEX IF NOT EXISTS idx_insigna_customers_churn ON insigna_customers(churn_risk_score) WHERE churn_risk_score > 0.5;

    -- 3.2 Reservation shadow record. reservation_id is the opaque
    -- token pushed by booking; we do NOT decode it back to the real
    -- bookings.id (cross-wall integrity).
    CREATE TABLE IF NOT EXISTS insigna_reservations (
      reservation_id        TEXT PRIMARY KEY,
      customer_hash         TEXT NOT NULL REFERENCES insigna_customers(customer_hash) ON DELETE CASCADE,
      booked_at             TEXT NOT NULL,
      scheduled_at          TEXT NOT NULL,
      party_size            INTEGER NOT NULL,
      channel               TEXT NOT NULL CHECK (channel IN ('LINE','WALKIN','PARTNER','PHONE')),
      status                TEXT NOT NULL CHECK (status IN ('CONFIRMED','CANCELLED','NOSHOW','COMPLETED')),
      special_occasion      TEXT,
      modified_count        INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_insigna_reservations_customer ON insigna_reservations(customer_hash);
    CREATE INDEX IF NOT EXISTS idx_insigna_reservations_scheduled ON insigna_reservations(scheduled_at);

    -- 3.3 Visit — the unit of analysis. visit_token is random per
    -- visit (no relation to reservation_id pattern) so a leaked
    -- visits row reveals no reservation context unless joined.
    CREATE TABLE IF NOT EXISTS insigna_visits (
      visit_token           TEXT PRIMARY KEY,
      customer_hash         TEXT NOT NULL REFERENCES insigna_customers(customer_hash) ON DELETE CASCADE,
      reservation_id        TEXT REFERENCES insigna_reservations(reservation_id) ON DELETE SET NULL,
      arrived_at            TEXT NOT NULL,
      departed_at           TEXT,
      party_size            INTEGER NOT NULL,
      party_type            TEXT NOT NULL CHECK (party_type IN ('SOLO','COUPLE','FAMILY','FRIENDS','BUSINESS','UNKNOWN')),
      table_id              TEXT,
      table_zone            TEXT CHECK (table_zone IN ('INDOOR','OUTDOOR','BAR','WINDOW','PRIVATE')),
      weather               TEXT,
      visit_trigger_src     TEXT,
      staff_notes           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_insigna_visits_customer ON insigna_visits(customer_hash);
    CREATE INDEX IF NOT EXISTS idx_insigna_visits_arrived ON insigna_visits(arrived_at);

    -- 3.4 Order items. menu_name_snapshot is DENORMALIZED — that's
    -- intentional per spec (historical accuracy if a menu item is
    -- later renamed). It's a menu name, NOT a customer name; the
    -- _snapshot suffix is what the PII lint allows past the 'name'
    -- blacklist.
    CREATE TABLE IF NOT EXISTS insigna_order_items (
      order_item_id         INTEGER PRIMARY KEY AUTOINCREMENT,
      visit_token           TEXT NOT NULL REFERENCES insigna_visits(visit_token) ON DELETE CASCADE,
      menu_id               TEXT NOT NULL,
      menu_name_snapshot    TEXT NOT NULL,
      category              TEXT NOT NULL CHECK (category IN ('APPETIZER','MAIN','PASTA','DESSERT','DRINK','WINE','OTHER')),
      quantity              INTEGER NOT NULL,
      unit_price            REAL NOT NULL,
      special_request       TEXT,
      is_repeat_order       INTEGER NOT NULL DEFAULT 0,
      ordered_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_insigna_order_items_visit ON insigna_order_items(visit_token);
    CREATE INDEX IF NOT EXISTS idx_insigna_order_items_menu ON insigna_order_items(menu_id);

    -- 3.5 Menu interactions (browse behavior). Optional source —
    -- only populated when LIFF menu surfaces are integrated (Phase 5).
    CREATE TABLE IF NOT EXISTS insigna_menu_interactions (
      interaction_id        INTEGER PRIMARY KEY AUTOINCREMENT,
      visit_token           TEXT NOT NULL REFERENCES insigna_visits(visit_token) ON DELETE CASCADE,
      menu_id               TEXT NOT NULL,
      action                TEXT NOT NULL CHECK (action IN ('VIEWED','EXPANDED','ADDED','REMOVED')),
      time_spent_sec        INTEGER,
      ordered               INTEGER NOT NULL DEFAULT 0,
      timestamp             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_insigna_menu_interactions_visit ON insigna_menu_interactions(visit_token);

    -- 3.6 Feedback. comment is free-text customer review — it may
    -- contain incidental PII (a name a customer voluntarily includes
    -- e.g. "the waiter Jay was great"). We accept that as inherent
    -- to feedback content; the PII lint targets *column intent*, not
    -- the value. AI sentiment + theme extraction stays NULL until
    -- Phase 2 swaps in Claude API.
    CREATE TABLE IF NOT EXISTS insigna_feedback (
      feedback_id           INTEGER PRIMARY KEY AUTOINCREMENT,
      visit_token           TEXT NOT NULL UNIQUE REFERENCES insigna_visits(visit_token) ON DELETE CASCADE,
      rating                INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      food_rating           INTEGER CHECK (food_rating BETWEEN 1 AND 5),
      service_rating        INTEGER CHECK (service_rating BETWEEN 1 AND 5),
      ambience_rating       INTEGER CHECK (ambience_rating BETWEEN 1 AND 5),
      comment               TEXT,
      sentiment             TEXT,
      themes                TEXT,
      submitted_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- 3.7 Tags (derived / staff-added / AI-suggested).
    CREATE TABLE IF NOT EXISTS insigna_customer_tags (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_hash         TEXT NOT NULL REFERENCES insigna_customers(customer_hash) ON DELETE CASCADE,
      tag                   TEXT NOT NULL,
      source                TEXT NOT NULL CHECK (source IN ('DERIVED','STAFF','AI')),
      confidence            REAL NOT NULL DEFAULT 1.0,
      created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(customer_hash, tag)
    );

    -- 3.8 Marketing campaigns.
    CREATE TABLE IF NOT EXISTS insigna_marketing_campaigns (
      campaign_id           TEXT PRIMARY KEY,
      channel               TEXT NOT NULL,
      campaign_name         TEXT NOT NULL,  -- "name" → "campaign_name" so the lint doesn't choke
      start_date            TEXT NOT NULL,
      end_date              TEXT,
      budget                REAL NOT NULL DEFAULT 0,
      actual_spend          REAL NOT NULL DEFAULT 0,
      goal_metric           TEXT,
      notes                 TEXT
    );

    -- 3.9 Campaign touchpoints. metadata is JSON-encoded text.
    CREATE TABLE IF NOT EXISTS insigna_campaign_touchpoints (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_hash         TEXT NOT NULL REFERENCES insigna_customers(customer_hash) ON DELETE CASCADE,
      campaign_id           TEXT NOT NULL REFERENCES insigna_marketing_campaigns(campaign_id) ON DELETE CASCADE,
      touchpoint_type       TEXT NOT NULL,
      timestamp             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      metadata              TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_insigna_touchpoints_customer ON insigna_campaign_touchpoints(customer_hash);

    -- 3.10 Attribution ledger.
    CREATE TABLE IF NOT EXISTS insigna_attribution_ledger (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      visit_token           TEXT NOT NULL REFERENCES insigna_visits(visit_token) ON DELETE CASCADE,
      campaign_id           TEXT REFERENCES insigna_marketing_campaigns(campaign_id) ON DELETE SET NULL,
      channel               TEXT NOT NULL,
      attribution_model     TEXT NOT NULL CHECK (attribution_model IN ('first_touch','last_touch','linear','time_decay','position')),
      attributed_revenue    REAL NOT NULL,
      attribution_weight    REAL NOT NULL,
      computed_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_insigna_attribution_visit ON insigna_attribution_ledger(visit_token);

    -- 3.11 Referral codes. The OWNER is the customer who gets the
    -- credit when their friends use it.
    CREATE TABLE IF NOT EXISTS insigna_referral_codes (
      code                       TEXT PRIMARY KEY,
      owner_customer_hash        TEXT NOT NULL REFERENCES insigna_customers(customer_hash) ON DELETE CASCADE,
      created_at                 TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at                 TEXT,
      uses_count                 INTEGER NOT NULL DEFAULT 0,
      converted_count            INTEGER NOT NULL DEFAULT 0,
      total_attributed_revenue   REAL NOT NULL DEFAULT 0
    );

    -- 3.12 Daily rollup precompute.
    CREATE TABLE IF NOT EXISTS insigna_daily_marketing_rollup (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      rollup_date           TEXT NOT NULL,
      channel               TEXT NOT NULL,
      spend                 REAL NOT NULL DEFAULT 0,
      new_customers         INTEGER NOT NULL DEFAULT 0,
      visits                INTEGER NOT NULL DEFAULT 0,
      revenue               REAL NOT NULL DEFAULT 0,
      roas                  REAL,
      cac                   REAL,
      computed_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(rollup_date, channel)
    );

    -- 3.13 Ingestion audit. payload_hash is a hash of the payload,
    -- NOT the payload itself — that's the entire point. Anyone
    -- reading the audit can verify "this exact event was processed
    -- at this exact moment" without recovering what the event
    -- contained. customer_hash is allowed (it's already
    -- pseudonymous everywhere else).
    CREATE TABLE IF NOT EXISTS insigna_ingestion_audit (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type            TEXT NOT NULL,
      customer_hash         TEXT,
      payload_hash          TEXT NOT NULL,
      received_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      processed             INTEGER NOT NULL DEFAULT 1,
      error                 TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_insigna_audit_received ON insigna_ingestion_audit(received_at);
  `);

  // ── FEASIBILITY (project investment feasibility, owner 2026-06-16) ──
  // One row per project. `inputs` holds the whole assumptions/startup/cost
  // model as JSON (shape in src/lib/feasibility.ts); all results are computed
  // client-side. `summary_cache` is a tiny {verdict, profit, payback} blob for
  // the list page so it needn't recompute every card. Scoped per creator in
  // the query layer (admin/super_admin only) — the SQLite equivalent of the
  // spec's RLS.
  db.exec(`
    CREATE TABLE IF NOT EXISTS feasibility_projects (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      created_by    INTEGER NOT NULL REFERENCES users(id),
      company       TEXT NOT NULL,
      project_name  TEXT NOT NULL,
      location      TEXT,
      business_type TEXT,
      status        TEXT NOT NULL DEFAULT 'draft',
      inputs        TEXT NOT NULL DEFAULT '{}',
      summary_cache TEXT,
      created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_feasibility_owner
      ON feasibility_projects(created_by, updated_at DESC);

    -- Itemised startup spend (owner 2026-06-16). Each startup category
    -- (construction/ffe/…) can hold a ledger of real payments — date, payee,
    -- amount, withholding tax (baht or %), document type + image, paid/pending.
    -- The category's number in feasibility_projects.inputs is kept = SUM(amount)
    -- of its items. Scoped via the parent project's owner.
    CREATE TABLE IF NOT EXISTS feasibility_startup_items (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id     INTEGER NOT NULL REFERENCES feasibility_projects(id) ON DELETE CASCADE,
      category       TEXT NOT NULL,
      paid_date      TEXT,
      item_name      TEXT NOT NULL,
      payee          TEXT,
      amount         REAL NOT NULL DEFAULT 0,
      wht_mode       TEXT NOT NULL DEFAULT 'none',  -- 'none' | 'baht' | 'pct'
      wht_value      REAL NOT NULL DEFAULT 0,
      doc_type       TEXT,                          -- 'tax_invoice' | 'receipt'
      payment_status TEXT NOT NULL DEFAULT 'paid',  -- 'paid' | 'pending'
      doc_image_path TEXT,
      created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_feasibility_startup_project
      ON feasibility_startup_items(project_id, category);
  `);

  // ── ACCOUNTA — expense ledger (owner 2026-06-16) ───────────────────
  // รายจ่าย: vendor bills, some paid / some on credit-term (ค้างชำระ).
  // Two time axes so we can show ACCRUAL (ตามบิล, by bill_date) vs CASH
  // FLOW (กระแสเงินสด, by paid_date) — e.g. a credit-card buy is booked in
  // the bill month but the cash only leaves when paid_date lands.
  // VAT (ภาษีซื้อ) is derived from the VAT-inclusive total when the bill
  // carries a full tax invoice (owner choice 2026-06-16): vat = round(total*7/107).
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounta_vendors (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      tax_id      TEXT,
      category    TEXT,                          -- default category hint
      active      INTEGER NOT NULL DEFAULT 1,
      created_by  INTEGER REFERENCES users(id),
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_accounta_vendors_active
      ON accounta_vendors(active, name);

    CREATE TABLE IF NOT EXISTS accounta_expenses (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id       INTEGER REFERENCES branches(id),
      company_id      INTEGER REFERENCES companies(id),
      bill_date       TEXT NOT NULL,                 -- accrual date (วันที่ตามบิล)
      vendor_id       INTEGER REFERENCES accounta_vendors(id),
      vendor_name     TEXT,                          -- denormalised (free-text ok)
      category        TEXT,
      description     TEXT,
      amount_total    REAL NOT NULL DEFAULT 0,       -- VAT-inclusive total entered
      has_tax_invoice INTEGER NOT NULL DEFAULT 0,    -- มีใบกำกับภาษีเต็มรูป
      vat_amount      REAL NOT NULL DEFAULT 0,       -- ภาษีซื้อ (derived, overridable)
      base_amount     REAL NOT NULL DEFAULT 0,       -- amount_total - vat_amount
      payment_status  TEXT NOT NULL DEFAULT 'paid',  -- 'paid' | 'unpaid' (ค้างชำระ/เครดิตเทอม)
      payment_method  TEXT,                          -- 'cash'|'transfer'|'credit_card'|'director'|'other'
      paid_date       TEXT,                          -- cash-flow date (เงินออกจริง); null while unpaid
      doc_path        TEXT,                          -- uploaded receipt/invoice image (outside www-root)
      doc_mime        TEXT,
      ocr_source      TEXT,                          -- model id when created via OCR, else null
      ocr_cost_baht   REAL,                          -- estimated OCR cost for this bill
      note            TEXT,
      created_by      INTEGER REFERENCES users(id),
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_accounta_expenses_bill
      ON accounta_expenses(branch_id, bill_date DESC);
    CREATE INDEX IF NOT EXISTS idx_accounta_expenses_paid
      ON accounta_expenses(payment_status, paid_date);

    -- OCR usage log: one row per bill-scan call, so the toggle UI can show
    -- "ใช้ไปแล้วกี่บาทเดือนนี้" without re-summing the Anthropic dashboard.
    CREATE TABLE IF NOT EXISTS accounta_ocr_usage (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      model         TEXT NOT NULL,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_baht     REAL NOT NULL DEFAULT 0,
      expense_id    INTEGER REFERENCES accounta_expenses(id) ON DELETE SET NULL,
      created_by    INTEGER REFERENCES users(id),
      created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_accounta_ocr_usage_created
      ON accounta_ocr_usage(created_at);

    -- Owner-extensible picklists (owner 2026-06-17): expense categories
    -- (seeded from the owner's Excel chart — UT/RT/GD/…) and payment
    -- channels (so future "director credit card · bank X" can be added
    -- without code). Expenses store the NAME as text; these tables are
    -- the dropdown source + add-new target.
    CREATE TABLE IF NOT EXISTS accounta_categories (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT,
      name       TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 100,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS accounta_payment_methods (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 100,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- รายรับ by payment channel (owner 2026-06-17, from the Excel income
    -- side). Channels are an owner-extensible picklist; income rows record
    -- one amount per channel per day per branch.
    CREATE TABLE IF NOT EXISTS accounta_income_channels (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 100,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS accounta_income (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id   INTEGER REFERENCES branches(id),
      company_id  INTEGER REFERENCES companies(id),
      income_date TEXT NOT NULL,
      channel     TEXT,
      amount      REAL NOT NULL DEFAULT 0,
      note        TEXT,
      created_by  INTEGER REFERENCES users(id),
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_accounta_income_date
      ON accounta_income(branch_id, income_date DESC);
  `);

  // Seed the picklists once (guarded by emptiness so owner edits stick).
  // Categories mirror the Excel expense codes; PF=Profit is income-side
  // and intentionally excluded.
  const catCount = (db.prepare("SELECT COUNT(*) AS c FROM accounta_categories").get() as { c: number }).c;
  if (catCount === 0) {
    const seedCat = db.prepare(
      "INSERT OR IGNORE INTO accounta_categories (code, name, sort_order) VALUES (?, ?, ?)"
    );
    [
      ["RT", "ค่าเช่า"],
      ["UT", "สาธารณูปโภค (น้ำ/ไฟ/เน็ต/ระบบ)"],
      ["LB", "ค่าแรง/เงินเดือน/ประกันสังคม"],
      ["GD", "สินค้า/เวชภัณฑ์"],
      ["ER", "ค่าเช่าอุปกรณ์"],
      ["AO", "อุปกรณ์/ของใช้สำนักงาน"],
      ["MK", "การตลาด/โฆษณา"],
      ["RM", "ซ่อมบำรุง"],
      ["FC", "ค่าธรรมเนียมการเงิน/แพลตฟอร์ม"],
      ["MI", "เบ็ดเตล็ด"],
      ["CP", "รายจ่ายลงทุน/ครุภัณฑ์ (CapEx)"],
      ["LN", "ชำระเงินกู้"]
    ].forEach(([code, name], i) => seedCat.run(code, name, (i + 1) * 10));
  }
  const pmCount = (db.prepare("SELECT COUNT(*) AS c FROM accounta_payment_methods").get() as { c: number }).c;
  if (pmCount === 0) {
    const seedPm = db.prepare(
      "INSERT OR IGNORE INTO accounta_payment_methods (name, sort_order) VALUES (?, ?)"
    );
    ["เงินสด", "โอนเงิน", "บัตรเครดิต", "กรรมการสำรองจ่าย", "อื่นๆ"]
      .forEach((name, i) => seedPm.run(name, (i + 1) * 10));
  }
  const icCount = (db.prepare("SELECT COUNT(*) AS c FROM accounta_income_channels").get() as { c: number }).c;
  if (icCount === 0) {
    const seedIc = db.prepare(
      "INSERT OR IGNORE INTO accounta_income_channels (name, sort_order) VALUES (?, ?)"
    );
    ["เงินสด", "QR / พร้อมเพย์", "บัตรเครดิต VISA", "บัตรเครดิต Mastercard",
     "บัตรเครดิต JCB", "บัตรเครดิต UnionPay"]
      .forEach((name, i) => seedIc.run(name, (i + 1) * 10));
  }

  // ── INSIGNA PII lint (spec section 6.1, NON-NEGOTIABLE) ─────
  // Walk every column of every `insigna_*` table and refuse to
  // proceed if any column name looks like personal data. This
  // catches "developer adds an `email` column without thinking
  // about the privacy wall" — the boot fails loudly rather than
  // silently shipping a PII leak.
  //
  // The blacklist is intentionally exact-match (plus a couple of
  // tight prefixes) so legitimate columns like menu_name_snapshot
  // and table_zone don't trip it. Add to FORBIDDEN_PII_COLS below
  // if a new identity vector surfaces — never relax this gate.
  const FORBIDDEN_PII_COLS = new Set<string>([
    "phone", "mobile",
    "email",
    "dob", "birth_date", "birthdate",
    "address", "street", "postal_code", "zip_code",
    "ip_address", "ip",
    "line_user_id", "line_id", "user_id",
    "name", "first_name", "last_name", "display_name",
    "full_name", "customer_name", "real_name",
    "national_id", "tax_id", "passport"
  ]);
  const insignaTables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'insigna_%'"
  ).all() as Array<{ name: string }>;
  for (const t of insignaTables) {
    const cols = db.prepare(`PRAGMA table_info("${t.name}")`).all() as Array<{ name: string }>;
    for (const c of cols) {
      if (FORBIDDEN_PII_COLS.has(c.name)) {
        throw new Error(
          `[INSIGNA PII LINT] Table ${t.name} has forbidden column '${c.name}'. ` +
          `Personal-data columns are NOT allowed in INSIGNA storage — that's the ` +
          `whole privacy wall. Review spec section 6.1, then either rename the ` +
          `column (e.g. campaign_name instead of name) or move the data back to ` +
          `the booking system where it belongs.`
        );
      }
    }
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
      default_escalation_hours: 24,
      improper_resignation_consequences: null,
      resignation_unlock_message: null,
      shift_greetings_work: null,
      shift_greetings_day_off: null,
      shift_greetings_on_leave: null,
      maintenance_message: null,
      maintenance_active: 0,
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
    // System-wide escalation window (hours) used by approval-chain
    // when an approver doesn't decide in time. Per-user override was
    // removed 2026-05 — this is now the single source of truth.
    default_escalation_hours?: number | null;
    // Owner-authored policy text for improper-resignation
    // consequences. Free-form Thai/English; rendered as-is on staff
    // resignation form + admin decide modal.
    improper_resignation_consequences?: string | null;
    // Body of the LINE card sent when admin opens a staff's
    // resignation gate. `{ADMIN}` placeholder replaced at send time.
    resignation_unlock_message?: string | null;
    // Shift-reminder greeting overrides — newline-separated. NULL
    // (omit field) leaves unchanged; "" clears back to defaults.
    shift_greetings_work?: string | null;
    shift_greetings_day_off?: string | null;
    shift_greetings_on_leave?: string | null;
    // Maintenance banner template text. Persisted even when banner is
    // off so the owner doesn't have to retype on every deploy.
    maintenance_message?: string | null;
    // Toggle: 0/1. Banner renders when BOTH this is 1 AND
    // maintenance_message is non-empty.
    maintenance_active?: 0 | 1 | boolean;
    // Public privacy-policy URL. Empty string → NULL = no "ดูนโยบาย"
    // button rendered on consent surfaces.
    privacy_policy_url?: string | null;
    // LINE group id receiving new-RECRUITA-application + PERSONA HR pushes.
    // Empty string → NULL = silent (no push fired).
    recruita_exec_group_id?: string | null;
    // Human-readable name for the exec/HR group (display only, not validated).
    recruita_exec_group_name?: string | null;
    // Inline PDPA text for the apply form. Empty → NULL = use the
    // built-in default. Newlines preserved.
    recruita_pdpa_text?: string | null;
    // RECRUITA interview venue map/navigation link. Empty → NULL = the
    // "นำทางมาสถานที่นัดสัมภาษณ์" button is omitted from the invite card.
    recruita_interview_map_url?: string | null;
    // RECRUITA health-check card body. Empty → NULL = card uses default.
    recruita_health_check_message?: string | null;
    // IKIGAI OS PORTAL OA add-friend link. Empty → NULL = button omitted.
    portal_oa_link?: string | null;
    // ACCOUNTA bill-OCR toggle (0/1) + chosen vision model.
    accounta_ocr_enabled?: 0 | 1 | boolean;
    accounta_ocr_model?: string | null;
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
    // Encrypt at rest (PDPA hardening 2026-05). Read path in line.ts
    // funnels through decryptSecret() so plaintext callers don't notice.
    const raw = norm(patch.global_line_channel_token ?? null);
    vals.push(raw ? encryptSecret(raw) : raw);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "global_staff_group_id")) {
    sets.push("global_staff_group_id = ?");
    vals.push(norm(patch.global_staff_group_id ?? null));
  }
  // Clamp 1–720 again at the DB boundary so a buggy caller can't
  // disable escalation by sending 0. Column is NOT NULL with default
  // 24, so we never write null here.
  if (Object.prototype.hasOwnProperty.call(patch, "default_escalation_hours") && patch.default_escalation_hours != null) {
    const v = Math.max(1, Math.min(720, Math.round(Number(patch.default_escalation_hours))));
    sets.push("default_escalation_hours = ?");
    vals.push(v);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "improper_resignation_consequences")) {
    sets.push("improper_resignation_consequences = ?");
    // Free-text; empty → NULL so the staff form skips the section.
    const raw = (patch.improper_resignation_consequences ?? "").trim();
    vals.push(raw === "" ? null : raw);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "resignation_unlock_message")) {
    sets.push("resignation_unlock_message = ?");
    // Free-text; empty → NULL so the unlock notification falls back
    // to the built-in default body.
    const raw = (patch.resignation_unlock_message ?? "").trim();
    vals.push(raw === "" ? null : raw);
  }
  // Shift-reminder greeting overrides — store as-is (preserving the
  // newlines that separate lines); empty → NULL so the picker falls
  // back to the built-in 4–5 default greetings per kind.
  for (const col of ["shift_greetings_work", "shift_greetings_day_off", "shift_greetings_on_leave"] as const) {
    if (Object.prototype.hasOwnProperty.call(patch, col)) {
      sets.push(`${col} = ?`);
      const raw = (patch[col] ?? "").trim();
      vals.push(raw === "" ? null : raw);
    }
  }
  // Maintenance banner — message is the template (persisted), active
  // is the on/off toggle. Both fields are independent so toggling
  // doesn't wipe the template text.
  if (Object.prototype.hasOwnProperty.call(patch, "maintenance_message")) {
    sets.push("maintenance_message = ?");
    const raw = (patch.maintenance_message ?? "").trim();
    vals.push(raw === "" ? null : raw);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "maintenance_active")) {
    sets.push("maintenance_active = ?");
    vals.push(patch.maintenance_active ? 1 : 0);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "privacy_policy_url")) {
    sets.push("privacy_policy_url = ?");
    const raw = (patch.privacy_policy_url ?? "").trim();
    vals.push(raw === "" ? null : raw);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "recruita_exec_group_id")) {
    sets.push("recruita_exec_group_id = ?");
    const raw = (patch.recruita_exec_group_id ?? "").trim();
    vals.push(raw === "" ? null : raw);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "recruita_exec_group_name")) {
    sets.push("recruita_exec_group_name = ?");
    const raw = (patch.recruita_exec_group_name ?? "").trim();
    vals.push(raw === "" ? null : raw);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "recruita_pdpa_text")) {
    sets.push("recruita_pdpa_text = ?");
    // Preserve the body as-is (trim outer whitespace only); empty → NULL
    // so the form falls back to DEFAULT_RECRUITA_PDPA_TEXT.
    const raw = (patch.recruita_pdpa_text ?? "").trim();
    vals.push(raw === "" ? null : raw);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "recruita_interview_map_url")) {
    sets.push("recruita_interview_map_url = ?");
    vals.push(norm(patch.recruita_interview_map_url));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "recruita_health_check_message")) {
    sets.push("recruita_health_check_message = ?");
    vals.push(norm(patch.recruita_health_check_message));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "portal_oa_link")) {
    sets.push("portal_oa_link = ?");
    vals.push(norm(patch.portal_oa_link));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "accounta_ocr_enabled")) {
    sets.push("accounta_ocr_enabled = ?");
    vals.push(patch.accounta_ocr_enabled ? 1 : 0);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "accounta_ocr_model")) {
    sets.push("accounta_ocr_model = ?");
    vals.push(norm(patch.accounta_ocr_model));
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
  reg_address: string | null;       // ที่อยู่จดทะเบียนของสาขา (เอกสารราชการ)
  tax_branch_code: string | null;   // '00000' = สำนักงานใหญ่, '00001'+ = สาขาที่ N
  open_time: string;
  close_time: string;
  slot_minutes: number;
  default_duration_minutes: number;
  reminder_minutes_before: number;
  line_channel_secret: string | null;
  line_channel_token: string | null;
  staff_line_user_ids: string | null;
  status: "open" | "coming_soon" | "closed";
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
  // Public LINE OA "add friend" URL (e.g., https://line.me/R/ti/p/@xxx).
  // When set, /reserva (customer branch picker) opens this URL on
  // tap instead of /reserva/<slug> — customer adds the OA first,
  // then the OA's rich menu deep-links to the booking form.
  customer_line_oa_url: string | null;
  // JSON: Array<{ target_slug: string; url: string | null; enabled: boolean }>
  // Cross-promotion entries when /reserva is visited with ?from=<thisBranch>.
  cross_promotions: string | null;
  staff_group_id: string | null;       // LINE group ID for staff notifications (preferred over staff_line_user_ids when set)
  // Per-event notification audience toggles (1 = send, 0 = mute).
  // staff_reminder defaults to 0 — the time-to-arrive heads-up in the
  // staff group was too noisy and was the first toggle admin asked for.
  notify_customer_pending: number;
  notify_customer_created: number;
  notify_customer_reminder: number;
  notify_staff_pending: number;
  notify_staff_created: number;
  notify_staff_reminder: number;
  readiness_morning_time: string;      // HH:MM — used in รอบเช้า card title (e.g. "11:30")
  readiness_afternoon_time: string;    // HH:MM — used in รอบบ่าย card title (e.g. "16:00")
  brand_color: string | null;          // Hex e.g. '#e94560'. NULL = default IKIGAI ink colour.
  // 2026-05-30 — shift_close default-field highlight toggles.
  // 1 = render in the red headline box at the top of the
  // post-shift summary card; 0 = fall through to the normal
  // checklist body (still bold via kind='amount', just less loud).
  // All three default 1 to preserve previous behaviour.
  sc_show_drawer_primary: number;
  sc_show_svc_primary: number;
  sc_show_revenue_primary: number;
  // 2026-05-30 — custom label (NULL = use hardcoded default) +
  // display order (lower renders first). Defaults 1/2/3 = legacy
  // closing → SVC → revenue sequence.
  sc_drawer_label: string | null;
  sc_svc_label: string | null;
  sc_revenue_label: string | null;
  sc_drawer_order: number;
  sc_svc_order: number;
  sc_revenue_order: number;
  // PERSONA Time Clock anti-cheat — see schema migration in getDb().
  latitude: number | null;
  longitude: number | null;
  geofence_radius_meters: number;
  geofence_enabled: number;            // 0/1
  clock_qr_token: string | null;
  clock_qr_enabled: number;            // 0/1
  // When 1, the shift_close staff form shows + requires a service
  // charge amount field at the top (feeds the staff-share
  // calculator). When 0 (default), the field is hidden and admin
  // backfills back-office. Added 2026-05-23.
  require_service_charge: number;      // 0/1
  require_yesterday_closing: number;   // 0/1
  require_morning_opening: number;     // 0/1
  require_today_closing: number;       // 0/1
  require_daily_revenue: number;       // 0/1 — shift_close "ยอดขายวันนี้"
  // Daily attendance summary (TC-6) — see migration block above.
  attendance_summary_time: string | null;           // HH:MM Bangkok, NULL = disabled
  attendance_summary_last_sent_date: string | null; // YYYY-MM-DD dedupe key
  shift_notify_time: string | null;                 // HH:MM Bangkok, NULL = auto disabled
  shift_notify_last_sent_date: string | null;       // YYYY-MM-DD dedupe key
  // Daily pending-requests digest (owner 2026-06-05) — see migration block.
  pending_digest_time: string | null;               // HH:MM Bangkok, NULL = digest disabled
  pending_digest_last_sent_date: string | null;     // YYYY-MM-DD dedupe key
  // Multiple attendance summaries (owner 2026-06-06) — routes to HR group.
  attendance_summary_times_json: string | null;     // JSON: ["08:30","17:00"]
  attendance_summary_sent_log: string | null;       // JSON: {"date":"…","sent":["08:30"]}
  // Per-branch INVENTA LINE group (owner 2026-06-06). NULL = global group.
  inventa_group_id: string | null;
  inventa_group_name: string | null;
  // INVENTA label print size in mm (owner 2026-06-08). Default 80×50.
  inventa_label_width_mm: number;
  inventa_label_height_mm: number;
  inventa_label_layout: string | null;
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
  // Hours an approver has before their pending leave/resignation
  // requests escalate up the chain-of-command. INTEGER, NOT NULL,
  // default 24. Set via /admin/system-settings.
  default_escalation_hours: number;
  // Owner-authored free text: "การลาออกไม่ถูกระเบียบจะเสียสิทธิ์
  // อะไรบ้าง". Shown to staff on the resignation form + to admin
  // beside the forfeit_svc checkbox on approval.
  improper_resignation_consequences: string | null;
  // LINE Flex body that fires when admin opens a staff's resignation
  // gate. `{ADMIN}` placeholder is replaced with the operator's
  // display_name. NULL/empty = use the built-in default.
  resignation_unlock_message: string | null;
  // Shift-reminder greeting overrides — newline-separated list per
  // kind. NULL/empty = fall back to pickShiftGreeting() defaults.
  // `{NAME}` placeholder is replaced with the recipient's nickname
  // with NO space after "พี่" (owner direction).
  shift_greetings_work: string | null;
  shift_greetings_day_off: string | null;
  shift_greetings_on_leave: string | null;
  /** Maintenance banner template — persistent text the owner authors
   *  once, kept in DB even when the banner is hidden. Pairs with
   *  maintenance_active (the on/off toggle) so toggling banner doesn't
   *  destroy the message. */
  maintenance_message: string | null;
  /** 0/1 toggle controlling whether the banner actually renders. Owner
   *  flips this before/after each deploy via /admin/system-settings.
   *  Banner shows iff active=1 AND message non-empty. */
  maintenance_active: number;
  /** ISO timestamp of the last /api/cron heartbeat. NULL = never
   *  pinged since the migration ran. Used by /admin/system-settings to
   *  surface "is the external cron actually firing?". */
  last_cron_run_at?: string | null;
  /** RECRUITA standard form template — JSON describing which fields
   *  appear on /recruita/apply/[id], their labels, required flag, and
   *  order. NULL = use the hardcoded DEFAULT_TEMPLATE from
   *  lib/recruita-form-template.ts (which mirrors the original
   *  hardcoded form). Admin edits via /admin/recruita/form-template. */
  recruita_form_template_json?: string | null;
  /** Public URL of the company's privacy policy / PDPA notice
   *  (typically a Canva published page or PDF on the website).
   *  Rendered as a "ดูนโยบาย" button on every consent surface in
   *  the app when set; consent surfaces hide the button on NULL. */
  privacy_policy_url?: string | null;
  /** LINE group id receiving the "new application submitted" Flex
   *  card pushed via the IKIGAI OS platform OA. NULL/empty = no
   *  push fired (silent fallback so the form still works on a fresh
   *  install). */
  recruita_exec_group_id?: string | null;
  /** Human-readable label for recruita_exec_group_id — shown in the
   *  PERSONA settings UI so admin can see which group name each
   *  notification setting routes to without memorising IDs. */
  recruita_exec_group_name?: string | null;
  /** Inline PDPA consent text shown on the RECRUITA apply form.
   *  NULL/empty = render the built-in DEFAULT_RECRUITA_PDPA_TEXT.
   *  Plaintext; newlines preserved on render. */
  recruita_pdpa_text?: string | null;
  /** Absolute path + mime of the uploaded PDPA policy image shown on
   *  the RECRUITA apply form (served via /api/recruita/pdpa-image).
   *  NULL = no image → form falls back to the default text. */
  recruita_pdpa_image_path?: string | null;
  recruita_pdpa_image_mime?: string | null;
  /** RECRUITA interview venue map/navigation URL (e.g. Google Maps share
   *  link). NULL/empty = the "นำทางมาสถานที่นัดสัมภาษณ์" button is omitted
   *  from the interview-invite LINE card. */
  recruita_interview_map_url?: string | null;
  /** RECRUITA health-check card body (admin-editable). NULL/empty = the
   *  card falls back to DEFAULT_HEALTH_CHECK_MESSAGE in recruita-notify. */
  recruita_health_check_message?: string | null;
  /** IKIGAI OS PORTAL OA add-friend deep link (e.g. https://lin.ee/xxxx).
   *  NULL/empty = the "เพิ่มเพื่อน IKIGAI OS PORTAL" button is omitted from
   *  the welcome card sent to a freshly-hired employee. */
  portal_oa_link?: string | null;
  /** ACCOUNTA bill-OCR master toggle. 0/1, default 0. When 0 the scan
   *  endpoint refuses and the UI hides the "ถ่ายรูปบิล" path. */
  accounta_ocr_enabled?: number | null;
  /** Which Claude vision model the OCR scan uses. NULL = the default
   *  (Haiku 4.5) resolved in lib/accounta-ocr.ts. */
  accounta_ocr_model?: string | null;
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
  /** How many months this warning stays "active" for the purposes of
   *  escalating subsequent offenses. NULL = no expiry (legacy default).
   *  Set by admin at issue time; common values: 3, 6, 12, 24. */
  validity_months: number | null;
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
  kind: "work" | "day_off";   // 'work' shift vs explicit day-off marker
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
  /** Honorific prefix shown before display_name everywhere (คุณ / นพ. / etc.).
   *  Column is on the users table; rendered via lib/name.nameWithPrefix. */
  title_prefix: string | null;
  role: UserRole;
  /** Account state — gates login. Added to the lean User type so
   *  auth.ts can drop sessions for resigned/disabled rows without
   *  having to cast to EmployeeProfile. Same union as on the rich
   *  profile type below; keep them in sync. */
  status: "active" | "pending_invite" | "disabled" | "resigned";
  /** PDPA payroll-access flag (2026-05-30). 0/1. Promoted to the
   *  lean User type so `userCanViewPayroll(sessionUser)` works
   *  without casting — the gate runs in many places (sidebar,
   *  payroll page, employee list column) and threading the cast
   *  everywhere would be noise. super_admin ignores this flag. */
  can_view_payroll: number;
  /** Mounjaro Wellness program — clinical access (2026-06-04).
   *  clinical_role ('doctor'|'nurse') + license_no gate clinical-data
   *  access (only the attending doctor sees their own patients, unlocked
   *  with the license number). is_hr_analytics grants aggregate-only
   *  program stats. Defaults: null / null / 0. */
  clinical_role: "doctor" | "nurse" | null;
  license_no: string | null;
  is_hr_analytics: number;
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
  status: "active" | "pending_invite" | "disabled" | "resigned";
  /** ISO timestamp the cron stamped when status flipped to 'resigned'
   *  (proposed_last_day on the approved resignation passed). NULL for
   *  users who haven't gone through the resignation flow. Drives the
   *  1-year purge sweep. */
  resigned_at: string | null;
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
  occasion: BookingOccasion | null;   // see OCCASION_KINDS — drives personalised reply
  // Verification + redemption (2026-05-24). NULL on legacy rows.
  verification_code: string | null;       // 6-char A-Z2-9 shown on Flex card + admin
  redemption_status: RedemptionStatus | null;
  redeemed_at: string | null;             // ISO when staff claimed
  redeemed_by_user_id: number | null;     // staff who clicked "เคลมไอติม"
};

/** Free-ice-cream redemption state machine. NULL = legacy row that
 *  pre-dates the feature. */
export type RedemptionStatus =
  | "eligible"        // first-time customer (no prior booking/walk-in matched by phone)
  | "claimed"         // staff handed the ice cream over (redeemed_at set)
  | "expired"         // 6 hours past booking_time without claim — cron sweeps
  | "not_eligible";   // returning customer — no offer

// Special-occasion enum — drives personalised LINE reply + staff
// preparation. Kept narrow on purpose so the reply templates stay
// hand-crafted per case. Customers who pick "other" or skip the
// field get the neutral confirmation copy.
export const OCCASION_KINDS = [
  "birthday",        // วันเกิด
  "anniversary",     // วันครบรอบ
  "business",        // ประชุมงาน
  "date",            // เดท
  "family",          // รวมญาติ / ครอบครัว
  "friends",         // พบเพื่อน
  "celebration",     // ฉลองทั่วไป
  "other"            // ระบุไว้ใน notes
] as const;
export type BookingOccasion = (typeof OCCASION_KINDS)[number];

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
  type: "shift_open" | "shift_close" | "readiness_1130" | "readiness_1600";
  /** Per-branch since 2026-05 — admin manages each branch's list independently. */
  branch_id: number;
  label: string;
  /** Render mode on the staff form:
   *    'checkbox' — yes/no tick (default for legacy rows).
   *    'text'     — free-form text input (e.g. "เมนูที่ไม่พร้อมขาย").
   *    'choice'   — one-of-N radio. Admin types the options at the
   *                 same time as the label; staff picks exactly one.
   *    'amount'   — currency input. Staff enters a baht amount with
   *                 2 decimal places; the LINE card renders it Thai-
   *                 number formatted (12,345.67 บาท). */
  /** 'section' renders as a non-interactive group header on staff
   *  forms + LINE Flex — no checkbox / input. Used to visually group
   *  related rows underneath without forcing the staff to "answer"
   *  the header. Section rows are silently skipped in summary
   *  counts (done/skipped/incomplete). */
  kind: "checkbox" | "text" | "choice" | "amount" | "section";
  /** JSON-encoded `string[]` of choice options when kind === 'choice',
   *  null otherwise. Use `parseChecklistOptions(row)` to read. */
  options_json: string | null;
  /** Self-referential link for 2-level nesting. NULL = top-level row
   *  shown directly in the staff form. Non-NULL = child row rendered
   *  indented under its parent. Children inherit their own kind/
   *  options — the link is purely visual + grouping. */
  parent_id: number | null;
  /** When kind='amount', flags this row to be rendered above the
   *  checklist body on the LINE Flex card. Multiple rows can carry
   *  this — they stack in display_order, with the FIRST one shown in
   *  biggest type and subsequent ones smaller. Stored as 1 / 0. */
  is_headline_amount: number;
  /** Optional small-text help shown under the row's label on the
   *  staff form + LINE Flex card. Used for examples or clarifications
   *  the label itself shouldn't carry. */
  description: string | null;
  display_order: number;
  active: number;          // 1 / 0
  created_at: string;
};

// parseChecklistOptions() moved to ./checklist-options.ts so client
// components can import it without dragging better-sqlite3 into the
// browser bundle. Server callers import from there too.

// ══════════════════════════════════════════════════════════════════
// RBAC helpers — roles, permissions, assignments (2026-06-04)
// All queries are defensive (tables created by runMigrations on first
// getDb()). Permission keys are validated against RBAC_PERMISSION_KEYS
// by the API layer (lib/rbac.ts); these helpers trust their inputs.
// ══════════════════════════════════════════════════════════════════

export type RbacRole = {
  id: number;
  key: string | null;
  name: string;
  description: string | null;
  is_system: number;
  permissions: string[];
  user_count: number;
};

/** All roles with their permission keys + how many users hold each.
 *  Ordered system-roles-first, then by name. */
export function listRbacRoles(): RbacRole[] {
  const db = getDb();
  const roles = db.prepare(
    `SELECT id, key, name, description, is_system
       FROM rbac_roles
      ORDER BY is_system DESC, name COLLATE NOCASE`
  ).all() as Array<Omit<RbacRole, "permissions" | "user_count">>;
  return roles.map((r) => {
    const perms = db.prepare(
      "SELECT permission_key FROM rbac_role_permissions WHERE role_id = ?"
    ).all(r.id) as Array<{ permission_key: string }>;
    const cnt = db.prepare(
      "SELECT COUNT(*) AS n FROM rbac_user_roles WHERE role_id = ?"
    ).get(r.id) as { n: number };
    return {
      ...r,
      permissions: perms.map((p) => p.permission_key),
      user_count: cnt.n
    };
  });
}

/** Union of permission keys a user holds across all their roles.
 *  super_admin is handled by userCan() (auth.ts) — this is the raw set. */
export function getUserPermissions(userId: number): string[] {
  const db = getDb();
  try {
    const rows = db.prepare(
      `SELECT DISTINCT rp.permission_key
         FROM rbac_user_roles ur
         JOIN rbac_role_permissions rp ON rp.role_id = ur.role_id
        WHERE ur.user_id = ?`
    ).all(userId) as Array<{ permission_key: string }>;
    return rows.map((r) => r.permission_key);
  } catch {
    // RBAC tables not migrated yet (fresh/old DB) → no extra perms.
    return [];
  }
}

/** Role ids currently assigned to a user. */
export function getUserRoleIds(userId: number): number[] {
  const db = getDb();
  try {
    const rows = db.prepare(
      "SELECT role_id FROM rbac_user_roles WHERE user_id = ?"
    ).all(userId) as Array<{ role_id: number }>;
    return rows.map((r) => r.role_id);
  } catch {
    return [];
  }
}

/** Create a custom (non-system) role. Returns the new role id. */
export function createRbacRole(
  name: string,
  description: string | null,
  permissions: string[]
): number {
  const db = getDb();
  const tx = db.transaction(() => {
    const info = db.prepare(
      "INSERT INTO rbac_roles (key, name, description, is_system) VALUES (NULL, ?, ?, 0)"
    ).run(name.trim(), description?.trim() || null);
    const roleId = Number(info.lastInsertRowid);
    for (const p of [...new Set(permissions)]) {
      db.prepare(
        "INSERT OR IGNORE INTO rbac_role_permissions (role_id, permission_key) VALUES (?, ?)"
      ).run(roleId, p);
    }
    return roleId;
  });
  return tx();
}

/** Rename + reset the permission set of a role. System roles can be
 *  edited (their perms/name) but never deleted. */
export function updateRbacRole(
  id: number,
  name: string,
  description: string | null,
  permissions: string[]
): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE rbac_roles SET name = ?, description = ? WHERE id = ?"
    ).run(name.trim(), description?.trim() || null, id);
    db.prepare("DELETE FROM rbac_role_permissions WHERE role_id = ?").run(id);
    for (const p of [...new Set(permissions)]) {
      db.prepare(
        "INSERT OR IGNORE INTO rbac_role_permissions (role_id, permission_key) VALUES (?, ?)"
      ).run(id, p);
    }
  });
  tx();
}

/** Delete a custom role (+ its permission rows and user assignments).
 *  System roles are protected. Returns false when blocked. */
export function deleteRbacRole(id: number): { ok: boolean; reason?: string } {
  const db = getDb();
  const role = db.prepare(
    "SELECT is_system FROM rbac_roles WHERE id = ?"
  ).get(id) as { is_system: number } | undefined;
  if (!role) return { ok: false, reason: "not_found" };
  if (role.is_system === 1) return { ok: false, reason: "system_role" };
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM rbac_role_permissions WHERE role_id = ?").run(id);
    db.prepare("DELETE FROM rbac_user_roles WHERE role_id = ?").run(id);
    db.prepare("DELETE FROM rbac_roles WHERE id = ?").run(id);
  });
  tx();
  return { ok: true };
}

/** Replace the full set of roles a user holds (delete + insert in a tx).
 *  Invalid role ids are ignored (FK-style guard via a membership check). */
export function setUserRoles(
  userId: number,
  roleIds: number[],
  assignedBy: number | null
): void {
  const db = getDb();
  const valid = new Set(
    (db.prepare("SELECT id FROM rbac_roles").all() as Array<{ id: number }>)
      .map((r) => r.id)
  );
  const wanted = [...new Set(roleIds)].filter((rid) => valid.has(rid));
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM rbac_user_roles WHERE user_id = ?").run(userId);
    for (const rid of wanted) {
      db.prepare(
        "INSERT OR IGNORE INTO rbac_user_roles (user_id, role_id, assigned_by) VALUES (?, ?, ?)"
      ).run(userId, rid, assignedBy);
    }
  });
  tx();
}
