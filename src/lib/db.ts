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
  if (!unames.has("weekly_off_day")) db.exec("ALTER TABLE users ADD COLUMN weekly_off_day INTEGER");
  // Phase 1C v6: resignation unlock (admin เปิดสิทธิ์ให้ staff ส่งคำขอลาออก)
  if (!unames.has("resignation_unlocked_at")) db.exec("ALTER TABLE users ADD COLUMN resignation_unlocked_at TEXT");
  if (!unames.has("resignation_unlocked_by")) db.exec("ALTER TABLE users ADD COLUMN resignation_unlocked_by INTEGER REFERENCES users(id)");

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

  // Audit log of payroll-period unlocks (paid → finalized via superadmin PIN)
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
  label: string;
  capacity: number;
  shape: "rect" | "round";
  x: number;
  y: number;
  width: number;
  height: number;
  active: number;
};

export type BookingStatus = "confirmed" | "seated" | "no_show" | "cancelled" | "completed";

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
};
