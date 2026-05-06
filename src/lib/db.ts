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

  db.exec(`
    CREATE TABLE IF NOT EXISTS public_holidays (
      date TEXT PRIMARY KEY,
      name_th TEXT NOT NULL,
      name_en TEXT NOT NULL
    );
  `);
  // Seed 2026 Thai public holidays (วันหยุดตามประเพณี — แอดมินสามารถปรับวันลูนาร์ได้)
  const seedHoliday = db.prepare(`
    INSERT INTO public_holidays (date, name_th, name_en) VALUES (?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET name_th = excluded.name_th, name_en = excluded.name_en
  `);
  const holidays2026: Array<[string, string, string]> = [
    ["2026-01-01", "วันขึ้นปีใหม่", "New Year's Day"],
    ["2026-03-03", "วันมาฆบูชา", "Makha Bucha Day"],
    ["2026-04-06", "วันจักรี", "Chakri Memorial Day"],
    ["2026-04-13", "วันสงกรานต์", "Songkran Day"],
    ["2026-04-14", "วันสงกรานต์", "Songkran Day"],
    ["2026-04-15", "วันสงกรานต์", "Songkran Day"],
    ["2026-05-01", "วันแรงงานแห่งชาติ", "National Labour Day"],
    ["2026-05-04", "วันฉัตรมงคล", "Coronation Day"],
    ["2026-05-31", "วันวิสาขบูชา", "Visakha Bucha Day"],
    ["2026-06-03", "วันเฉลิมพระชนมพรรษาสมเด็จพระบรมราชินี", "Queen's Birthday"],
    ["2026-07-28", "วันเฉลิมพระชนมพรรษา ร.10", "King's Birthday"],
    ["2026-07-30", "วันอาสาฬหบูชา", "Asalha Bucha Day"],
    ["2026-07-31", "วันเข้าพรรษา", "Buddhist Lent Day"],
    ["2026-08-12", "วันเฉลิมพระชนมพรรษาสมเด็จพระบรมราชชนนีพันปีหลวง / วันแม่", "Mother's Day"],
    ["2026-10-13", "วันคล้ายวันสวรรคต ร.9", "King Bhumibol Memorial Day"],
    ["2026-10-23", "วันปิยมหาราช", "Chulalongkorn Day"],
    ["2026-12-05", "วันคล้ายวันพระบรมราชสมภพ ร.9 / วันชาติ", "King Bhumibol's Birthday / National Day"],
    ["2026-12-10", "วันรัฐธรรมนูญ", "Constitution Day"],
    ["2026-12-31", "วันสิ้นปี", "New Year's Eve"]
  ];
  for (const h of holidays2026) seedHoliday.run(...h);
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
