// Read-only access ไปยัง Payroll DB เพื่อใช้ user table ร่วมกัน (SSO)
// ห้าม mutate Payroll DB จาก Next.js — แค่อ่าน users
import Database from "better-sqlite3";
import fs from "node:fs";

const PAYROLL_DB_PATH =
  process.env.PAYROLL_DB_PATH || "/var/www/ikigai-payroll/webapp/db/payroll.db";

let _db: Database.Database | null = null;

export function getPayrollDb(): Database.Database {
  if (_db) return _db;
  if (!fs.existsSync(PAYROLL_DB_PATH)) {
    throw new Error(
      `Payroll DB not found at ${PAYROLL_DB_PATH} — set PAYROLL_DB_PATH ใน .env`
    );
  }
  _db = new Database(PAYROLL_DB_PATH, { readonly: true, fileMustExist: true });
  _db.pragma("journal_mode = WAL");
  return _db;
}

export type PayrollUser = {
  id: number;
  username: string;
  password_hash: string;
  display_name: string;
  role: string;     // 'admin' | 'staff' | อื่นๆ
  created_at: string;
};

export function findPayrollUserByUsername(username: string): PayrollUser | null {
  try {
    const row = getPayrollDb()
      .prepare("SELECT * FROM users WHERE username = ?")
      .get(username) as PayrollUser | undefined;
    return row ?? null;
  } catch (e) {
    console.error("[payroll-db] findUserByUsername error:", e);
    return null;
  }
}

export function findPayrollUserById(id: number): PayrollUser | null {
  try {
    const row = getPayrollDb()
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(id) as PayrollUser | undefined;
    return row ?? null;
  } catch (e) {
    console.error("[payroll-db] findUserById error:", e);
    return null;
  }
}
