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
