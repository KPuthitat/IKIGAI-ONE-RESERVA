// Data access สำหรับ Payroll DB (PERSONA module)
// อ่าน users สำหรับ SSO อยู่แล้วใน payroll-db.ts (readonly) — ไฟล์นี้รองรับ write
// สำหรับฟีเจอร์ HR ใหม่ (clock_entries, ฯลฯ)
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
  _db = new Database(PAYROLL_DB_PATH, { fileMustExist: true });
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  // ensure clock_entries table — for Phase 1B mobile clock-in
  _db.exec(`
    CREATE TABLE IF NOT EXISTS clock_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('in','out')),
      ts TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      ip TEXT,
      ua TEXT,
      branch_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_clock_entries_emp_ts
      ON clock_entries(employee_id, ts);
  `);
  return _db;
}

// === Types ===

/** Part-time employee — มี portal login + เก็บ pin/password hash */
export type Employee = {
  id: number;
  code: string;
  name: string;
  national_id: string | null;
  tax_type: string;            // PND default
  base_salary: number;
  welfare: number;
  bank_name: string | null;
  bank_account: string | null;
  is_active: number;           // 0 | 1
  pin_hash: string | null;
  company_id: number | null;
  branch_id: number | null;
  address: string | null;
  portal_username: string | null;
  portal_password_hash: string | null;
  hire_date: string | null;
  pay_cycle: string;           // 'MONTHLY' default
};

/** Full-time employee — เงินเดือนคงที่ ไม่มี portal login */
export type FtEmployee = {
  id: number;
  code: string;
  name: string;
  national_id: string | null;
  tax_type: string;
  base_salary: number;
  welfare: number;
  bank_name: string | null;
  bank_account: string | null;
  is_active?: number;
};

export type Timesheet = {
  id: number;
  employee_id: number;
  work_date: string;
  wd_we: string;
  month_label: string;
  year_label: number;
  shift: string | null;
  is_ot: number;
  ot_end: string | null;
  le_flag: string | null;
  ns_flag: string | null;
  work_in: string | null;
  work_out: string | null;
  notes: string | null;
  abs_flag: string | null;
};

export type FtAttendance = {
  id: number;
  emp_id: number;
  work_date: string;
  is_present: number;
};

export type Position = {
  code: string;
  department: string;
  label: string;
  description: string | null;
  sort_order: number;
};

export type LeaveRequest = {
  id: number;
  employee_id: number;
  employee_type: string;        // 'pt' | 'ft' (assumption)
  leave_type: string;
  start_date: string;
  end_date: string;
  days: number;
  reason: string | null;
  status: string;               // PENDING/APPROVED/REJECTED
  admin_note: string | null;
  reviewed_by: string | null;
  created_at: string;
  reviewed_at: string | null;
};

export type AppSetting = {
  key: string;
  value: string;
};

// === Read functions ===

export function listEmployees(opts: { activeOnly?: boolean } = {}): Employee[] {
  const where = opts.activeOnly ? "WHERE is_active = 1" : "";
  return getPayrollDb()
    .prepare(`SELECT * FROM employees ${where} ORDER BY code`)
    .all() as Employee[];
}

export function listFtEmployees(opts: { activeOnly?: boolean } = {}): FtEmployee[] {
  // ft_employees อาจไม่มี is_active — เลือกทั้งหมดถ้า column ไม่มี
  try {
    const where = opts.activeOnly ? "WHERE COALESCE(is_active, 1) = 1" : "";
    return getPayrollDb()
      .prepare(`SELECT * FROM ft_employees ${where} ORDER BY code`)
      .all() as FtEmployee[];
  } catch {
    return getPayrollDb().prepare("SELECT * FROM ft_employees ORDER BY code").all() as FtEmployee[];
  }
}

export function getEmployeeStats(): {
  pt: number; ft: number; ptActive: number; ftActive: number;
} {
  const db = getPayrollDb();
  const safeCount = (sql: string): number => {
    try { return (db.prepare(sql).get() as { n: number }).n; }
    catch { return 0; }
  };
  return {
    pt:        safeCount("SELECT COUNT(*) AS n FROM employees"),
    ft:        safeCount("SELECT COUNT(*) AS n FROM ft_employees"),
    ptActive:  safeCount("SELECT COUNT(*) AS n FROM employees WHERE is_active = 1"),
    ftActive:  safeCount("SELECT COUNT(*) AS n FROM ft_employees WHERE COALESCE(is_active, 1) = 1")
  };
}

/** Pending leave + correction requests count — สำหรับ dashboard */
export function getPendingCounts(): { leave: number; corrections: number } {
  const db = getPayrollDb();
  const safe = (sql: string) => {
    try { return (db.prepare(sql).get() as { n: number }).n; }
    catch { return 0; }
  };
  return {
    leave: safe("SELECT COUNT(*) AS n FROM leave_requests WHERE status = 'PENDING'"),
    corrections: safe("SELECT COUNT(*) AS n FROM time_correction_requests WHERE status = 'PENDING'")
  };
}

/** ค่ายเดียวที่ใช้ใน Payroll (PND อย่างเดียวตอนนี้) */
export const TAX_TYPE_LABELS: Record<string, string> = {
  PND: "ภ.ง.ด. (PND)"
};

// === Clock entries (Phase 1B — mobile clock-in with PIN) ===

export type ClockEntry = {
  id: number;
  employee_id: number;
  type: "in" | "out";
  ts: string;
  ip: string | null;
  ua: string | null;
  branch_id: number | null;
};

export type ClockResult =
  | { kind: "ok"; employee: { id: number; code: string; name: string }; nextAction: "in" | "out" | "done"; lastIn?: string; lastOut?: string }
  | { kind: "invalid_pin" }
  | { kind: "ambiguous_pin" }
  | { kind: "inactive" };

/** Bangkok local date string YYYY-MM-DD ของ timestamp */
function bkkDate(d: Date | string): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  return new Date(dt.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * หาพนักงานจาก PIN — เปรียบเทียบ bcrypt ทุก active employee
 * คืน:
 *  - ok: เจอคนเดียว — มีข้อมูลพนักงาน + next action
 *  - invalid_pin: ไม่เจอเลย
 *  - ambiguous_pin: เจอมากกว่า 1 คน (ต้อง enforce uniqueness ตอน admin set)
 *  - inactive: เจอแต่ is_active = 0
 */
export function lookupByPin(pin: string): ClockResult {
  if (!/^\d{4}$/.test(pin)) return { kind: "invalid_pin" };
  const db = getPayrollDb();
  const employees = db.prepare(
    "SELECT id, code, name, is_active, pin_hash FROM employees WHERE pin_hash IS NOT NULL AND pin_hash != ''"
  ).all() as Array<{ id: number; code: string; name: string; is_active: number; pin_hash: string }>;

  // ใช้ bcryptjs (โหลดแบบ lazy เพราะใช้ในที่เดียว)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const bcrypt = require("bcryptjs") as typeof import("bcryptjs");

  const matches = employees.filter((e) => {
    try { return bcrypt.compareSync(pin, e.pin_hash); }
    catch { return false; }
  });

  if (matches.length === 0) return { kind: "invalid_pin" };
  if (matches.length > 1) return { kind: "ambiguous_pin" };

  const emp = matches[0];
  if (!emp.is_active) return { kind: "inactive" };

  // หา clock entries ของพนักงานวันนี้
  const today = bkkDate(new Date());
  const todayStartIso = new Date(`${today}T00:00:00+07:00`).toISOString();
  const todayEndIso = new Date(`${today}T23:59:59+07:00`).toISOString();
  const entries = db.prepare(`
    SELECT type, ts FROM clock_entries
    WHERE employee_id = ? AND ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `).all(emp.id, todayStartIso, todayEndIso) as Array<{ type: "in" | "out"; ts: string }>;

  const lastIn = entries.find((e) => e.type === "in")?.ts;
  const lastOut = entries.find((e) => e.type === "out")?.ts;

  let nextAction: "in" | "out" | "done";
  if (!lastIn) nextAction = "in";
  else if (!lastOut) nextAction = "out";
  else nextAction = "done";

  return { kind: "ok", employee: { id: emp.id, code: emp.code, name: emp.name }, nextAction, lastIn, lastOut };
}

/** บันทึก clock entry หลัง verify แล้ว — return ใหม่ entry id */
export function recordClock(opts: {
  employee_id: number;
  type: "in" | "out";
  ip?: string | null;
  ua?: string | null;
  branch_id?: number | null;
}): number {
  const db = getPayrollDb();
  const r = db.prepare(`
    INSERT INTO clock_entries (employee_id, type, ip, ua, branch_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(opts.employee_id, opts.type, opts.ip ?? null, opts.ua ?? null, opts.branch_id ?? null);
  return r.lastInsertRowid as number;
}
