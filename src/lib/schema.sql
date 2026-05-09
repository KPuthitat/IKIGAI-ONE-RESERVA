-- IKIGAI OS RESERVA — schema
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  open_time TEXT NOT NULL DEFAULT '11:00',
  close_time TEXT NOT NULL DEFAULT '22:00',
  slot_minutes INTEGER NOT NULL DEFAULT 30,
  default_duration_minutes INTEGER NOT NULL DEFAULT 90,
  reminder_minutes_before INTEGER NOT NULL DEFAULT 60,
  line_channel_secret TEXT,
  line_channel_token TEXT,
  staff_line_user_ids TEXT,            -- JSON array: ["U1234...","U5678..."] รับแจ้งเตือนพนักงาน
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','staff')),
  pin_hash TEXT,                       -- bcrypt 4-digit PIN for time clock
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_branches (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, branch_id)
);

CREATE TABLE IF NOT EXISTS tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  shape TEXT NOT NULL DEFAULT 'rect' CHECK (shape IN ('rect','round')),
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  width REAL NOT NULL DEFAULT 80,
  height REAL NOT NULL DEFAULT 80,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (branch_id, label)
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  table_id INTEGER REFERENCES tables(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  party_size INTEGER NOT NULL CHECK (party_size > 0),
  source TEXT,                        -- รู้จักร้านจากไหน เช่น Instagram, Facebook, friend
  customer_origin TEXT,               -- มาจากไหน sriracha | chonburi | other_province
  is_member INTEGER,                  -- 1 = สมาชิกแล้ว, 0 = ยังไม่เคย, NULL = ไม่ตอบ
  booking_date TEXT NOT NULL,         -- YYYY-MM-DD (โซนเวลาไทย)
  booking_time TEXT NOT NULL,         -- HH:MM
  duration_minutes INTEGER NOT NULL DEFAULT 90,
  -- pending_review = customer submitted via the public form without a table;
  -- admin must assign a table + click "Confirm and notify" to push the
  -- Flex confirmation card. Walk-in / phone / staff-entered bookings can
  -- skip this state by going straight to 'confirmed' (or 'seated' for
  -- walk-ins who are already at the table).
  status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('pending_review','confirmed','seated','no_show','cancelled','completed')),
  notes TEXT,
  line_user_id TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  seated_at TEXT,
  cancelled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_bookings_branch_date ON bookings(branch_id, booking_date);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_table ON bookings(table_id);

CREATE TABLE IF NOT EXISTS notification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                 -- created | reminder | seated | cancelled
  audience TEXT NOT NULL,             -- customer | staff
  channel TEXT NOT NULL DEFAULT 'line',
  status TEXT NOT NULL,               -- sent | failed | skipped
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  error TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                -- random 32-byte hex
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_branch_id INTEGER REFERENCES branches(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Time clock entries (PERSONA module — staff ลงเวลาเข้า/ออกงาน)
CREATE TABLE IF NOT EXISTS time_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('in','out')),
  ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_time_entries_user_ts ON time_entries(user_id, ts);

-- Audit log สำหรับ admin แก้/ลบ time entries (ต้อง trace ได้ว่าใครทำอะไรเมื่อไหร่)
CREATE TABLE IF NOT EXISTS time_entries_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER,                    -- id เดิม (จะ NULL ไม่ได้แม้ entry ถูกลบ → snapshot ไว้แล้ว)
  entry_user_id INTEGER NOT NULL,      -- เจ้าของ entry เดิม
  entry_type TEXT NOT NULL,            -- 'in' | 'out'
  entry_ts TEXT NOT NULL,              -- timestamp เดิม
  action TEXT NOT NULL CHECK (action IN ('delete','edit','create')),
  admin_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_time_audit_created ON time_entries_audit(created_at);

-- Leave requests (PERSONA — Phase 1C)
-- 8 ประเภทตาม กม. แรงงานไทย: sick / personal / annual / maternity /
--                              ordination / sterilization / pilgrimage / military
CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN
    ('sick','personal','annual','maternity','ordination','sterilization','pilgrimage','military')),
  date_from TEXT NOT NULL,    -- YYYY-MM-DD (Bangkok local)
  date_to TEXT NOT NULL,      -- YYYY-MM-DD (inclusive)
  days REAL NOT NULL,         -- รองรับครึ่งวัน (0.5 = ครึ่งวัน, 1 = เต็มวัน)
  reason TEXT,                -- เหตุผลที่ staff ระบุ
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','approved','rejected','cancelled')),
  decided_by INTEGER REFERENCES users(id),  -- admin ที่อนุมัติ/ปฏิเสธ
  decided_at TEXT,
  decision_note TEXT,         -- comment จาก admin
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_leave_user_status ON leave_requests(user_id, status);
CREATE INDEX IF NOT EXISTS idx_leave_status_created ON leave_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_leave_dates ON leave_requests(date_from, date_to);
