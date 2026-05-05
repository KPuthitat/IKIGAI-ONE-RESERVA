// Read-only data access สำหรับ Payroll DB (PERSONA module)
// อ่าน users สำหรับ SSO อยู่แล้วใน payroll-db.ts — ไฟล์นี้สำหรับฟีเจอร์ HR
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
