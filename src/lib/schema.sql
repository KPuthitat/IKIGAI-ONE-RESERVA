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
  status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed','seated','no_show','cancelled','completed')),
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
